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
const mail      = require('../../Helpers/mail');
const db        = require('../../config/db').db;
// Licences + entitlements + subscriptions live in the MASTER db. When a request
// is tenant-routed (als = a tenant db), reach them via masterDb explicitly.
const masterDb  = require('../../config/masterDb').db;

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

/**
 * Build the licence summary the frontends show (login + /me): expiry
 * (valid_until + days_left), the plan limits (max_companies, max_users) and how
 * many company slots are used / remaining. Returns null for the super-admin (no
 * licence) or a user with no licence. Best-effort on the tenant company count —
 * a tenant-db hiccup leaves companies_used null rather than failing login/me.
 */
async function buildLicenseInfo(roleSlug, licenseId) {
    if (roleSlug === 'super-admin' || !licenseId) return null;
    const lic = await masterDb('licenses').where('id', licenseId).whereNull('deleted_at')
        .first('valid_until', 'status', 'max_companies', 'max_users');
    if (!lic) return null;

    let daysLeft = null;
    if (lic.valid_until) {
        const vu = new Date(lic.valid_until);
        const t0 = new Date(); t0.setHours(0, 0, 0, 0);
        daysLeft = Math.floor((vu.getTime() - t0.getTime()) / 86400000);
    }

    // Company slots used = the licence's non-deleted companies (its tenant db).
    let companiesUsed = null;
    try {
        const tdb = require('../../config/tenantDb').getKnexForLicense(licenseId);
        const [{ c }] = await tdb('companies').whereNull('deleted_at').count({ c: '*' });
        companiesUsed = Number(c) || 0;
    } catch (_) { /* best-effort — leave null */ }

    // User seats used = the licence's non-deleted logins (master.users is the
    // auth source of truth, one row per login across the licence).
    let usersUsed = null;
    try {
        const [{ u }] = await masterDb('users').where('license_id', licenseId).whereNull('deleted_at').count({ u: '*' });
        usersUsed = Number(u) || 0;
    } catch (_) { /* best-effort — leave null */ }

    const maxCompanies = lic.max_companies != null ? Number(lic.max_companies) : null;
    const maxUsers     = lic.max_users != null ? Number(lic.max_users) : null;
    return {
        valid_until:  lic.valid_until,
        status:       lic.status,
        days_left:    daysLeft,
        max_companies: maxCompanies,
        max_users:    maxUsers,
        companies_used: companiesUsed,
        companies_remaining: (maxCompanies != null && companiesUsed != null)
            ? Math.max(0, maxCompanies - companiesUsed) : null,
        users_used: usersUsed,
        users_remaining: (maxUsers != null && usersUsed != null)
            ? Math.max(0, maxUsers - usersUsed) : null,
    };
}

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
        // Auth is against the MASTER db. Roles live in the tenant DBs, so master
        // can't join them — master.users carries a denormalised `role_slug`
        // (+ role_id pointing at the tenant role) which is all login needs.
        const user = await db('users as u')
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
                'u.role_slug',
            )
            .first();
        if (user) user.role_name = user.role_slug || null;

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

        // 4. Access gate. The COMPANY LICENCE is the single source of truth for
        //    validity — a salesman / company user is valid for as long as the
        //    company's licence is, NOT a separate per-user expiry that can drift.
        //    The per-user subscription row is only the SEAT marker (active = the
        //    user is within the licence's seat cap). Super Admin bypasses both.
        if (!isSuperAdmin) {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const lic = user.license_id
                ? await db('licenses').where('id', user.license_id).whereNull('deleted_at')
                    .first('status', 'valid_until')
                : null;
            const licValid = !!(lic && lic.status === 'active'
                && (!lic.valid_until || new Date(lic.valid_until).toISOString().slice(0, 10) >= today));
            if (!licValid) {
                return R.errorResponse(res, 'Your subscription has expired. Please contact your administrator.', 403);
            }
            // Active SEAT (within the licence's max_users) — provisioned by seat
            // reconcile; NOT date-checked here (the licence owns the date).
            const seat = await db('subscriptions')
                .where({ user_id: user.id, status: 'active' }).first('id');
            if (!seat) {
                return R.errorResponse(res, 'Your account is inactive — the licence seat limit is reached. Please contact your administrator.', 403);
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

        // Which PLATFORM is signing in — the web BFF sends `client:'web'`, the app
        // sends `client:'app'` (default 'web'). Drives the per-platform session
        // model below. The Tally agent uses a SEPARATE agent token (not here).
        const platform = (req.body && String(req.body.client).toLowerCase() === 'app') ? 'app' : 'web';

        // Drop truly-expired sessions for this user first (housekeeping).
        await db('user_sessions').where('user_id', user.id)
            .andWhere('expires_at', '<', nowDate).del();

        // Session model: ONE live session PER PLATFORM. Web and app are tracked
        // separately, so signing in on the app NEVER logs the web session out (and
        // vice-versa) — the user can be signed in on web AND app at once. But a
        // SECOND login on the SAME platform evicts the first (last-login-wins per
        // platform). Super Admin is exempt (any number of sessions). Legacy rows
        // (platform NULL, pre-change) count as 'web'.
        if (!isSuperAdmin) {
            const victims = await db('user_sessions').where('user_id', user.id)
                .where(function () {
                    this.where('platform', platform);
                    if (platform === 'web') this.orWhereNull('platform');
                })
                .select('id');
            if (victims.length) {
                await db('user_sessions').whereIn('id', victims.map((s) => s.id)).del();
                console.error(`[LOGIN-EVICT] user=${user.id} (${user.email}) platform=${platform} evicted ${victims.length} prior session(s) on this platform`);
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
            platform,
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
            // Per-license multi-DB: the tenant DB this user's requests route to
            // (via tenantResolver → runWithTenant). Super-admin has no licence →
            // null → resolveTenant falls through to the master/global pool.
            db_name:    user.license_id ? `tally_lic_${user.license_id}` : null,
            jti,
        });

        // Permission slugs for the role (drives the web's menu/dashboard RBAC).
        // Super Admin short-circuits to ['*']; everyone else gets their role's
        // granted slugs (e.g. 'sales-invoices.view').
        let permissions;
        if (user.role_slug === 'super-admin') {
            permissions = ['*'];
        } else {
            // Role permissions live in the user's TENANT db (login runs on master,
            // so reach the tenant explicitly by licence).
            const tdb = user.license_id
                ? require('../../config/tenantDb').getKnexForLicense(user.license_id)
                : db;
            const permRows = await tdb('role_permissions as rp')
                .join('permissions as p', 'p.id', 'rp.permission_id')
                .where('rp.role_id', user.role_id)
                .select('p.slug');
            let slugs = permRows.map((r) => r.slug);
            // PLAN GATE — effective permissions = role grants ∩ the licence's
            // entitlement (license_permissions, master). MUST mirror /me so login
            // and /me agree, else the web menu (built from the login perms) shows
            // modules the super-admin removed from the licence. A licence with no
            // explicit entitlements resolves to ALL (no filtering).
            if (user.license_id) {
                const { entitledSlugSet } = require('../../Helpers/entitlements');
                const entitled = await entitledSlugSet(user.license_id);
                if (entitled) slugs = slugs.filter((s) => entitled.has(s));
            }
            permissions = slugs;
        }

        // SFA — is this user a LINKED salesman? Drives the web/app draft +
        // approval UI and the "see only my invoices" scoping. Stashed on the
        // session at login so res.locals.isSalesman works without a /me round-trip.
        let salesPersonId = null;
        const adminish = ['super-admin', 'company-admin', 'admin', 'owner']
            .includes(user.role_slug);
        if (!adminish && user.company_id && user.license_id) {
            // sales_persons lives in the user's TENANT db (login runs on master).
            const tdb = require('../../config/tenantDb').getKnexForLicense(user.license_id);
            const sp = await tdb('sales_persons')
                .where({ user_id: user.id, company_id: user.company_id })
                .whereNull('deleted_at').first('id');
            if (sp) salesPersonId = Number(sp.id);
        }

        // License validity + limits — powers the "your licence expires in N days"
        // banner AND the company-admin's top licence strip (valid-until, remaining
        // companies, max users). Single source of truth for access after expiry.
        const licenseInfo = await buildLicenseInfo(user.role_slug, user.license_id);

        // 7. Success envelope — never echo the password_hash.
        return R.successResponse(res, {
            token,
            user: {
                id:              user.id,
                name:            user.name,
                email:           user.email,
                role:            user.role_name,
                role_slug:       user.role_slug,
                company_id:      user.company_id,
                permissions,
                is_salesman:     !!salesPersonId,
                sales_person_id: salesPersonId,
                license:         licenseInfo,
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

        // No roles join: super-admin runs against master (no roles table) and a
        // company user against the tenant mirror (which has role_id but not
        // role_slug). The role comes off the verified JWT instead; role_id (the
        // tenant role) still drives the permission lookup below.
        const user = await db('users as u')
            .where('u.id', userId)
            .whereNull('u.deleted_at')
            .select(
                'u.id',
                'u.company_id',
                'u.license_id',
                'u.role_id',
                'u.location_id',
                'u.name',
                'u.email',
                'u.mobile',
                'u.status',
                'u.last_login_at',
            )
            .first();

        // Token valid but the row is gone/soft-deleted → treat as unauthenticated.
        if (!user) {
            return R.errorResponse(res, 'Authentication failed. Please log in again.', 401);
        }
        user.role_slug = (req.user && req.user.role_slug) || null;
        user.role_name = user.role_slug;

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
            let slugs = rows.map((r) => r.slug);
            // PLAN GATE — effective permissions = role grants ∩ the licence's
            // entitlement, so the menu/UI only shows features the plan includes
            // (mirrors rbac.can()'s server-side block).
            const licenseId = user.license_id || (req.user && req.user.license_id);
            if (licenseId) {
                const { entitledSlugSet } = require('../../Helpers/entitlements');
                const entitled = await entitledSlugSet(licenseId);
                if (entitled) slugs = slugs.filter((s) => entitled.has(s));
            }
            permissions = slugs;
        }

        // Field-sales (SFA): is this user a LINKED salesman (a sales_persons row
        // points user_id at them)? Drives the app/web draft + approval UI and the
        // "see only my created invoices" scoping. Admins/owners are never salesmen.
        let salesPersonId = null;
        const adminish = ['super-admin', 'company-admin', 'admin', 'owner']
            .includes(user.role_slug);
        if (!adminish && user.company_id) {
            const sp = await db('sales_persons')
                .where({ user_id: userId, company_id: user.company_id })
                .whereNull('deleted_at')
                .first('id');
            if (sp) salesPersonId = Number(sp.id);
        }

        // License validity + limits — so the app/web can warn the company before
        // it expires (a top banner) AND show the top licence strip (valid-until,
        // remaining companies, max users). Super Admin has no company licence.
        const licenseInfo = await buildLicenseInfo(user.role_slug, user.license_id);

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
            is_salesman:     !!salesPersonId,
            sales_person_id: salesPersonId,
            license:         licenseInfo,
        });
    } catch (err) {
        console.error('AuthController.me error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/account/change-password
 *
 * The LOGGED-IN user changes their OWN password. Requires the current password
 * (so a stolen session can't silently reset it) + a new one. Available to EVERY
 * role — it operates on req.user.sub only, never another account.
 *   body: { current_password, new_password }
 */
async function changePassword(req, res) {
    try {
        const userId = req.user && req.user.sub;
        if (!userId) return R.errorResponse(res, 'Please sign in again.', 401);

        const currentPassword = String((req.body && req.body.current_password) || '');
        const newPassword     = String((req.body && req.body.new_password) || '');
        if (!currentPassword || !newPassword) {
            return R.errorResponse(res, 'Enter your current and new password.', 422);
        }
        if (newPassword.length < 6) {
            return R.errorResponse(res, 'The new password must be at least 6 characters.', 422);
        }

        const user = await db('users').where('id', userId).whereNull('deleted_at')
            .first('id', 'password_hash');
        if (!user) return R.errorResponse(res, 'Please sign in again.', 401);

        const ok = await passwords.verify(currentPassword, user.password_hash);
        if (!ok) return R.errorResponse(res, 'Your current password is incorrect.', 422);

        if (await passwords.verify(newPassword, user.password_hash)) {
            return R.errorResponse(res, 'The new password must be different from the current one.', 422);
        }

        const newHash = await passwords.hash(newPassword);
        await db('users').where('id', userId).update({ password_hash: newHash, updated_at: new Date() });
        return R.successResponse(res, null, 'Your password has been changed.');
    } catch (err) {
        console.error('AuthController.changePassword error:', err);
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

// ─── Password reset (forgot-password) ──────────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000;                       // code valid 60 minutes
const sha256  = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const genCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/**
 * POST /api/v1/auth/forgot-password   { email }
 *
 * ALWAYS replies with the same generic message (no account enumeration). When
 * the email maps to an Active user, we store a HASHED 6-digit code (latest-wins,
 * 15-min expiry) in `password_resets` and email it via Helpers/mail.
 */
async function forgotPassword(req, res) {
    const { email } = req.body;
    const GENERIC = 'If that email is registered, a reset code has been sent.';
    try {
        const user = await db('users')
            .whereRaw('lower(email) = ?', [email])
            .whereNull('deleted_at')
            .first('id', 'name', 'email', 'status');

        if (user && user.status === 'Active') {
            const code = genCode();
            await db('password_resets').where('email', user.email).del();   // latest-wins
            await db('password_resets').insert({
                email:      user.email,
                token:      sha256(code),
                expires_at: new Date(Date.now() + RESET_TTL_MS),
                created_at: new Date(),
            });
            try {
                await mail.sendPasswordResetCode(user.email, code, user.name);
            } catch (mailErr) {
                console.error('forgotPassword: email send failed:', mailErr.message);
            }
        }
        return R.successResponse(res, null, GENERIC);
    } catch (err) {
        console.error('AuthController.forgotPassword error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/auth/reset-password   { email, code, password }
 *
 * Verifies the (un-expired) hashed code, sets the new password, consumes the
 * code, and revokes all existing sessions so the user must sign in afresh.
 */
async function resetPassword(req, res) {
    const { email, code, password } = req.body;
    const BAD = 'The code is invalid or has expired. Please request a new one.';
    try {
        const row = await db('password_resets')
            .where('email', email)
            .andWhere('expires_at', '>', new Date())
            .orderBy('id', 'desc')
            .first();
        if (!row || row.token !== sha256(code)) {
            return R.errorResponse(res, BAD, 400);
        }

        const user = await db('users')
            .whereRaw('lower(email) = ?', [email])
            .whereNull('deleted_at')
            .first('id');
        if (!user) {
            return R.errorResponse(res, BAD, 400);
        }

        const hash = await passwords.hash(password);
        await db('users').where('id', user.id)
            .update({ password_hash: hash, updated_at: new Date() });

        // Consume the code(s) + revoke every live session (force a fresh login).
        await db('password_resets').where('email', email).del();
        await db('user_sessions').where('user_id', user.id).del();
        await db('users').where('id', user.id)
            .update({ active_session_jti: null, session_expires_at: null });

        return R.successResponse(res, null, 'Your password has been reset. Please sign in.');
    } catch (err) {
        console.error('AuthController.resetPassword error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = {
    login,
    me,
    changePassword,
    logout,
    forgotPassword,
    resetPassword,
    // exported for tests / reuse
    BAD_CREDS_MSG,
    DISABLED_MSG,
};
