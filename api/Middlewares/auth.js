'use strict';

/**
 * api/Middlewares/auth.js
 *
 * Express middleware: verifies the JWT from `Authorization: Bearer <token>`
 * and attaches the decoded payload to `req.user`. Any failure (missing
 * header, malformed header, bad signature, expired, etc.) emits ONE generic
 * 401 envelope:
 *
 *   HTTP 200  body: { status: 401, show: true,
 *                     msg: "Authentication failed. Please log in again." }
 *
 * The single generic message is intentional — identical behaviour for every
 * failure mode keeps the auth surface predictable and avoids leaking which
 * part of the token was wrong.
 *
 * After this runs, `req.user` holds the JWT payload:
 *   { sub, company_id, role_id, role_slug, name, iat, exp }
 * Downstream middlewares (companyScope, rbac) assume it exists.
 */

const R   = require('../Helpers/response');
const jwt = require('../Helpers/jwt');
const db  = require('../config/db').db;

const AUTH_FAIL_MSG    = 'Authentication failed. Please log in again.';
const SESSION_ENDED_MSG = 'Your session has ended. Please log in again.';

/**
 * Extract a Bearer token from the request, or return null. Tolerant of header
 * casing (Express lowercases keys, but defensive code is cheap).
 */
function extractToken(req) {
    const raw = req.headers.authorization || req.headers.Authorization || '';
    if (typeof raw !== 'string') return null;
    const m = raw.match(/^Bearer\s+(\S+)$/i);
    return m ? m[1] : null;
}

/**
 * Middleware: require a valid JWT.
 *
 * On success: sets `req.user = decodedPayload` and calls next().
 * On failure: ends the response with the generic 401 envelope.
 */
async function authenticate(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return R.errorResponse(res, AUTH_FAIL_MSG, 401);
    }

    let payload;
    try {
        payload = jwt.verify(token);
    } catch (err) {
        // bad signature / expired / malformed → one generic message.
        return R.errorResponse(res, AUTH_FAIL_MSG, 401);
    }

    // Web-session enforcement: a user token carries a `jti` that must still map
    // to a LIVE row in user_sessions. A logout deletes that row; a fresh login
    // elsewhere that exceeds the company's session cap EVICTS the oldest row
    // (last-login-wins) — either way the matching row is gone, so this token
    // stops working on its next request. Also re-checks the user is present +
    // Active, so a deleted/disabled account is rejected mid-session.
    // (Agent tokens use kind:'agent' + authenticateAgent — no jti here.)
    if (payload && payload.jti) {
        try {
            const session = await db('user_sessions').where('jti', payload.jti).first();
            const user = await db('users')
                .where('id', payload.sub)
                .whereNull('deleted_at')
                .select('status')
                .first();
            const now = new Date();
            const expired = session && session.expires_at && new Date(session.expires_at) < now;
            if (!session || expired || !user || user.status !== 'Active') {
                return R.errorResponse(res, SESSION_ENDED_MSG, 401);
            }
            // Refresh this session's liveness.
            await db('user_sessions').where('id', session.id).update({ last_seen_at: now });
        } catch (err) {
            console.error('authenticate session check error:', err);
            return R.errorResponse(res, AUTH_FAIL_MSG, 401);
        }
    }

    req.user = payload;
    return next();
}

/**
 * Middleware: require the caller to be the platform Super Admin. Runs AFTER
 * `authenticate` (reads req.user.role_slug). Used to gate license management.
 */
function requireSuperAdmin(req, res, next) {
    if (req.user && req.user.role_slug === 'super-admin') return next();
    return R.errorResponse(res, 'Super Admin access required.', 403);
}

/**
 * Middleware: authenticate the Python sync AGENT (not a user). The agent token
 * is a JWT with kind:'agent' + license_id (+ machine_id), issued by
 * /agent/activate. We RE-VALIDATE the license server-side on every call —
 * status, expiry and machine binding — so entitlement is never trusted from
 * the token alone (instant suspend works, a copied token to another machine is
 * rejected). Sets req.license.
 */
async function authenticateAgent(req, res, next) {
    const token = extractToken(req);
    if (!token) return R.errorResponse(res, 'Agent token required.', 401);

    let payload;
    try { payload = jwt.verify(token); } catch (err) { return R.errorResponse(res, 'Invalid agent token.', 401); }
    if (!payload || payload.kind !== 'agent' || !payload.license_id) {
        return R.errorResponse(res, 'Invalid agent token.', 401);
    }

    try {
        const lic = await db('licenses')
            .where('id', payload.license_id)
            .whereNull('deleted_at')
            .select('id', 'status', 'valid_until', 'machine_id', 'holder_name', 'plan')
            .first();
        if (!lic) return R.errorResponse(res, 'License not found.', 401);
        if (lic.status !== 'active') return R.errorResponse(res, `License is ${lic.status}.`, 403);
        const today = new Date().toISOString().slice(0, 10);
        if (lic.valid_until && String(lic.valid_until).slice(0, 10) < today) {
            return R.errorResponse(res, 'License has expired.', 403);
        }
        if (payload.machine_id && lic.machine_id && payload.machine_id !== lic.machine_id) {
            return R.errorResponse(res, 'License is bound to another machine.', 403);
        }
        req.license = lic;
        req.agent = payload;
        return next();
    } catch (err) {
        console.error('authenticateAgent error:', err);
        return R.errorResponse(res, 'Agent authentication failed.', 401);
    }
}

module.exports = {
    authenticate,
    requireSuperAdmin,
    authenticateAgent,
    // exposed for tests + future granular middlewares
    extractToken,
    AUTH_FAIL_MSG,
    SESSION_ENDED_MSG,
};
