'use strict';

/**
 * api/Helpers/jwt.js
 *
 * Issues + verifies JSON Web Tokens for the API. HS256 (symmetric, single
 * secret in .env) — asymmetric keys are overkill for a single-signer monolith.
 *
 * Token payload (TallySaaS — single-DB, company_id multi-tenancy):
 *
 *   { sub: <user_id>, company_id: <id|null>, role_id, role_slug, name }
 *
 *   • company_id is null for the Super Admin (cross-company operator).
 *   • role_slug is what the RBAC + company-scope middlewares branch on
 *     (e.g. 'super-admin' bypasses permission checks).
 *
 * The secret is read at CALL time (not module load) so unrelated scripts
 * (migrations, seeds) can run without JWT_SECRET set; sign/verify throw a
 * clear error if it's missing or shorter than 32 chars.
 */

const jwt = require('jsonwebtoken');

const ALG        = 'HS256';
const MIN_SECRET = 32; // chars

/**
 * Read + validate JWT_SECRET at call time. Throws a descriptive error when
 * unset or too short, with a one-liner to generate a strong value.
 */
function getSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) {
        throw new Error('JWT_SECRET is not set in .env.');
    }
    if (s.length < MIN_SECRET) {
        throw new Error(
            `JWT_SECRET is too short (${s.length} chars). Need at least ${MIN_SECRET}. ` +
            `Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
        );
    }
    return s;
}

/**
 * Issue a JWT. `expiresIn` accepts the jsonwebtoken format ("24h", "15m",
 * "7d", or a number of seconds). Defaults to env JWT_EXPIRES_IN, then '24h'.
 *
 *   sign({ sub: 42, company_id: 7, role_id: 2, role_slug: 'company-admin', name: 'Asha' })
 */
function sign(payload, expiresIn) {
    if (!payload || typeof payload !== 'object') {
        throw new TypeError('sign(payload) requires an object payload.');
    }
    const exp = expiresIn || process.env.JWT_EXPIRES_IN || '24h';
    return jwt.sign(payload, getSecret(), { algorithm: ALG, expiresIn: exp });
}

/**
 * Verify and decode a token. Throws on:
 *   - invalid signature → JsonWebTokenError
 *   - expired token     → TokenExpiredError
 *   - missing/short secret (caller/config bug, not the token's fault)
 *
 * The auth middleware translates these into a generic 401 envelope.
 */
function verify(token) {
    if (!token || typeof token !== 'string') {
        // Cast to the same error class jsonwebtoken would use so callers can
        // handle a single error type for all "bad token" cases.
        throw new jwt.JsonWebTokenError('Missing or non-string token');
    }
    return jwt.verify(token, getSecret(), { algorithms: [ALG] });
}

module.exports = {
    sign,
    verify,
    // re-exported for instanceof checks in middleware/tests:
    JsonWebTokenError: jwt.JsonWebTokenError,
    TokenExpiredError: jwt.TokenExpiredError,
};
