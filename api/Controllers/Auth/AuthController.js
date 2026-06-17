'use strict';

/**
 * api/Controllers/Auth/AuthController.js
 *
 * Authentication endpoints (spec §3):
 *
 *   login  — POST /api/v1/auth/login
 *            { email, password } → { token, user, expires_in }
 *   me     — GET  /api/v1/me          (behind authenticate)
 *            fresh user row + role + flat list of permission slugs
 *   logout — POST /api/v1/auth/logout
 *            stateless 200 (the JWT is bearer-only; the client drops the token)
 *
 * Security notes:
 *   • ONE generic credential message (`BAD_CREDS_MSG`) for "no such user" AND
 *     "wrong password" so we never reveal which emails exist.
 *   • Timing-safe miss: when the email isn't found we still run a password
 *     verify against a fixed dummy argon2 hash, so a missing-user response
 *     takes about as long as a wrong-password one (defeats user-enumeration by
 *     response timing).
 *   • Lazy re-hash: a legacy bcrypt hash that verifies successfully is upgraded
 *     to argon2id and written back on the same request ("migrate on next login").
 *
 * Single DB, row-level multi-tenancy: a user carries `company_id` (NULL for the
 * platform Super Admin). The JWT payload mirrors what the middleware chain needs
 * downstream: { sub, company_id, role_id, role_slug, name }.
 */

const crypto    = require('node:crypto');
const R         = require('../../Helpers/response');
const jwt       = require('../../Helpers/jwt');
const passwords = require('../../Helpers/passwords');
const db        = require('../../config/db').db;

// Session tuning.
//   SESSION_TTL_MS — how long a web session row stays valid (≈ token life). On
//                    expiry the row is pruned and the token stops working.
// The number of concurrent sessions a user may hold is NOT fixed here — it is
// configurable per company (companies.max_sessions_per_user); see login().
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;     // 24 hours

// Generic message for ANY auth miss (unknown email OR wrong password). Keeping
// them identical is what prevents account enumeration.
const BAD_CREDS_MSG = 'Email or password is incorrect.';
const DISABLED_MSG  = 'Your account is disabled.';

// A fixed, real argon2id hash of a throwaway password. Used ONLY to burn a
// comparable amount of CPU when the email doesn't exist, so a miss and a
// wrong-password both take ~the same time. (Hash of the literal string
// 'timing-safe-dummy-password' with the helper's ARGON_OPTS.)
const DUMMY_HASH =
    '$argon2id$v=19$m=65536,t=3,p=1$yvBNACGhmG2DJG0iSRNd5g$tr3ucRvo+pfvpnVw6c3Oi2NzaHpy0vBrXRbzAT8Uqfo';

// How long the issued token is valid for. Mirrors the value baked into the JWT
// by jwt.sign so the client can pre-empt expiry. (jwt.sign reads the same env.)
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

/**
 * POST /api/v1/auth/login
 *
 * Body has already been validated + normalised by validate(loginSchema):
 * `email` is trimmed + lower-cased, `password` is a non-empty string.
 */
async function login(req, res) {
    const { email, password } = req.body;

    try {
        // 1. Look up the active (not soft-deleted) user by lower(email), pulling
        //    the role name + slug in one join. Email is stored lower-cased, but
        //    we lower() defensively so case never causes a false miss.
        const user = await db('users as u')
            .leftJoin('roles as r', 'r.id', 'u.role_id')
            .whereRaw('lower(u.email) = ?', [email])
            .whereNull('u.deleted_at')
            .select(
                'u.id',
                'u.company_id',
                'u.license_id',
                'u.role_id',
                'u.name',
                'u.email',
                'u.password_hash',
                'u.status',
                'u.approval_status',
                'u.active_session_jti',
                'u.session_last_seen',
                'u.session_expires_at',
                'r.name as role_name',
                'r.slug as role_slug',
            )
            .first();

        // 2. Verify the password. On a MISS, verify against the dummy hash so the
        //    code path (and timing) matches the wrong-password path, then bail
        //    with the SAME generic message.
        if (!user) {
            await passwords.verify(password, DUMMY_HASH);
            return R.errorResponse(res, BAD_CREDS_MSG, 401);
        }

        const ok = await passwords.verify(password, user.password_hash);
        if (!ok) {
            return R.errorResponse(res, BAD_CREDS_MSG, 401);
        }

        // 3. Account must be Active. This is now the SEAT gate: a license allows
        //    max_users Active users (the license-admin + the oldest up to the
        //    cap); the newest excess users are system-deactivated (Inactive), so
        //    an over-seat user is blocked here with a clear message. (Manual
        //    approval is RETIRED — there is no longer a pending/approval gate.)
        //    Checked AFTER a successful password verify so a disabled account
        //    can't be probed unless the caller already knows the password.
        if (user.status !== 'Active') {
            const msg = user.status === 'Inactive'
                ? 'Your account is inactive — the license seat limit is reached. Please contact your administrator.'
                : DISABLED_MSG;
            return R.errorResponse(res, msg, 403);
        }

        const isSuperAdmin = user.role_slug === 'super-admin';

        // 4. Subscription gate (per-user). Super Admin (platform owner) bypasses.
        //    Reject when there is no active, in-date subscription.
        if (!isSuperAdmin) {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const sub = await db('subscriptions')
                .where({ user_id: user.id, status: 'active' })
                .where('valid_until', '>=', today)
                .first();
            if (!sub) {
                return R.errorResponse(res, 'Your subscription has expired. Please contact your administrator.', 403);
            }
        }

        // 5. Concurrent-session limit (WEB logins only — the Tally agent uses a
        //    separate agent token and is never counted here). Super Admin is
        //    EXEMPT (may sign in from any number of places). For company users the
        //    cap is configurable PER COMPANY by the Super Admin
        //    (companies.max_sessions_per_user, default 1). Policy is
        //    LAST-LOGIN-WINS: a new login never blocks — instead the oldest
        //    session(s) are evicted so the live count stays within the cap. An
        //    evicted session's row is deleted, so its token stops working on its
        //    next request (see authenticate middleware).
        const nowDate = new Date();
        const jti = crypto.randomUUID();
        const sessionExpires = new Date(Date.now() + SESSION_TTL_MS);

        // Drop truly-expired sessions for this user first (housekeeping).
        await db('user_sessions').where('user_id', user.id)
            .andWhere('expires_at', '<', nowDate).del();

        if (!isSuperAdmin) {
            let limit = 1;
            if (user.company_id) {
                const company = await db('companies').where('id', user.company_id)
                    .select('max_sessions_per_user').first();
                if (company && company.max_sessions_per_user != null) {
                    limit = Math.max(1, Number(company.max_sessions_per_user));
                }
            }
            // Evict oldest logins so that, once the new session is added below,
            // the live count never exceeds `limit`. (Keep the most recent logins.)
            const live = await db('user_sessions').where('user_id', user.id)
                .orderBy('created_at', 'asc').select('id');
            const evictCount = live.length + 1 - limit;
            if (evictCount > 0) {
                const victimIds = live.slice(0, evictCount).map((s) => s.id);
                await db('user_sessions').whereIn('id', victimIds).del();
            }
        }

        // 6. Lazy re-hash (best-effort).
        if (passwords.needsRehash(user.password_hash)) {
            try {
                const fresh = await passwords.hash(password);
                await db('users').where('id', user.id)
                    .update({ password_hash: fresh, updated_at: new Date() });
            } catch (rehashErr) {
                console.error('login: lazy re-hash failed:', rehashErr);
            }
        }

        // 7. Open the new session: persist a row (the source of truth the
        //    authenticate middleware matches the token's jti against) and stamp
        //    last-login on the user. The jti is baked into the JWT below.
        await db('user_sessions').insert({
            user_id:      user.id,
            jti,
            ip:           String(req.headers['x-forwarded-for'] || req.ip || '').slice(0, 64) || null,
            user_agent:   String(req.headers['user-agent'] || '').slice(0, 255) || null,
            last_seen_at: nowDate,
            expires_at:   sessionExpires,
            created_at:   nowDate,
        });
        await db('users').where('id', user.id).update({
            last_login_at:      nowDate,
            active_session_jti: jti,        // quick "current session" reference
            session_last_seen:  nowDate,
            session_expires_at: sessionExpires,
            updated_at:         nowDate,
        });

        // 8. Issue the JWT. Payload is exactly what the middleware chain reads.
        const token = jwt.sign({
            sub:        user.id,
            company_id: user.company_id,
            license_id: user.license_id,
            role_id:    user.role_id,
            role_slug:  user.role_slug,
            name:       user.name,
            jti,
        });

        // 7. Success envelope — never echo the password_hash.
        return R.successResponse(res, {
            token,
            user: {
                id:         user.id,
                name:       user.name,
                email:      user.email,
                role:       user.role_name,
                role_slug:  user.role_slug,
                company_id: user.company_id,
            },
            expires_in: EXPIRES_IN,
        }, 'Login successful.');
    } catch (err) {
        console.error('AuthController.login error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /api/v1/me  (behind authenticate → req.user holds the JWT payload)
 *
 * Returns a FRESH read of the caller's row (status/role may have changed since
 * the token was minted) plus the role and the flat list of permission slugs the
 * role grants. Super Admin is reported with `permissions: ['*']` since rbac
 * bypasses checks for that role.
 */
async function me(req, res) {
    try {
        const userId = req.user && req.user.sub;
        if (!userId) {
            return R.errorResponse(res, 'Authentication failed. Please log in again.', 401);
        }

        const user = await db('users as u')
            .leftJoin('roles as r', 'r.id', 'u.role_id')
            .where('u.id', userId)
            .whereNull('u.deleted_at')
            .select(
                'u.id',
                'u.company_id',
                'u.role_id',
                'u.location_id',
                'u.name',
                'u.email',
                'u.mobile',
                'u.status',
                'u.last_login_at',
                'r.name as role_name',
                'r.slug as role_slug',
            )
            .first();

        // Token valid but the row is gone/soft-deleted → treat as unauthenticated.
        if (!user) {
            return R.errorResponse(res, 'Authentication failed. Please log in again.', 401);
        }

        // Permission slugs for the role. Super Admin short-circuits to ['*'].
        let permissions;
        if (user.role_slug === 'super-admin') {
            permissions = ['*'];
        } else {
            const rows = await db('role_permissions as rp')
                .join('permissions as p', 'p.id', 'rp.permission_id')
                .where('rp.role_id', user.role_id)
                .select('p.slug')
                .orderBy('p.slug', 'asc');
            permissions = rows.map((r) => r.slug);
        }

        return R.successResponse(res, {
            id:            user.id,
            name:          user.name,
            email:         user.email,
            mobile:        user.mobile,
            status:        user.status,
            company_id:    user.company_id,
            location_id:   user.location_id,
            last_login_at: user.last_login_at,
            role: {
                id:   user.role_id,
                name: user.role_name,
                slug: user.role_slug,
            },
            permissions,
        });
    } catch (err) {
        console.error('AuthController.me error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/auth/logout
 *
 * Stateless: the API issues bearer JWTs and keeps no server-side session, so
 * "logout" is a client concern (drop the token). We acknowledge with a plain
 * 200 envelope so the client can confirm and clear local state. (A token
 * deny-list / refresh-rotation scheme would land here in a later phase.)
 */
async function logout(req, res) {
    try {
        // Delete ONLY this session's row (other devices stay signed in). Runs
        // behind `authenticate`, so req.user (incl. jti) is set.
        const userId = req.user && req.user.sub;
        const jti    = req.user && req.user.jti;
        if (jti) {
            await db('user_sessions').where('jti', jti).del();
        }
        // If this was the user's "current session" pointer, clear it too.
        if (userId && jti) {
            await db('users').where('id', userId).where('active_session_jti', jti).update({
                active_session_jti: null,
                session_expires_at: null,
                updated_at: new Date(),
            });
        }
    } catch (err) {
        console.error('AuthController.logout error:', err);
    }
    return R.successResponse(res, null, 'Logged out.');
}

module.exports = {
    login,
    me,
    logout,
    // exported for tests / reuse
    BAD_CREDS_MSG,
    DISABLED_MSG,
};
