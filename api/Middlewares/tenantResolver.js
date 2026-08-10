'use strict';

/**
 * api/Middlewares/tenantResolver.js
 *
 * Per-license multi-DB: attaches the caller's tenant Knex pool to `req.db` from
 * the `db_name` claim the login baked into the JWT (`tally_lic_<id>`).
 * (Adapted from the IOT reference's Middlewares/tenantResolver.js.)
 *
 * Mount AFTER authenticate, BEFORE the tenant controller:
 *   router.get('/customers', authenticate, resolveTenant, resolveLocation, can(...), CustomerController.list);
 *
 * A Super Admin token carries NO db_name (they operate on the master / pick a
 * license explicitly) — those tenant routes reject it with the same generic
 * 401 as an unauthenticated caller (no info leak). Super-admin cross-tenant
 * work uses the separate super-admin bridge (Phase 2) which resolves the tenant
 * db from an explicit ?license_id / X-License-Id.
 *
 * Two rollout flags gate the strictness here (both default OFF, see .env.example):
 *   TENANT_STRICT_DB_NAME=true   — reject a non-super-admin token that carries
 *                                  no db_name instead of falling through to the
 *                                  shared global pool.
 *   TENANT_DB_STRICT_ROLES=true  — (config/tenantCredentials) refuse to open a
 *                                  tenant pool under the shared admin login.
 */

const R      = require('../Helpers/response');
const tenant = require('../config/tenantDb');
const { runWithTenant } = require('../config/db');

const AUTH_FAIL = 'Authentication failed. Please log in again.';

function resolveTenant(req, res, next) {
    const u = req.user;
    if (!u || typeof u !== 'object') return R.errorResponse(res, AUTH_FAIL, 401);

    // Super-admin legitimately carries no db_name: they work on the master pool
    // or go through the explicit super-admin bridge (?license_id / X-License-Id).
    if (u.role_slug === 'super-admin') return next();

    const hasDbName = !!u.db_name && typeof u.db_name === 'string';

    // TRANSITION-TOLERANT (default): a token minted before the per-licence split
    // carries no `db_name` — fall through so `db(...)` uses the global single-DB
    // pool and old sessions keep working.
    //
    // TENANT_STRICT_DB_NAME=true closes that door. It matters because the
    // fall-through is reachable by simply OMITTING the claim: anyone able to
    // mint or replay a db_name-less token lands on the shared global pool
    // instead of their own tenant. Turn it on once every live session has been
    // re-issued (they expire on their own; forcing a re-login is faster).
    if (!hasDbName) {
        if (String(process.env.TENANT_STRICT_DB_NAME || '').toLowerCase() === 'true') {
            console.warn(`tenantResolver: rejecting token without db_name (user ${u.id || '?'}) — strict mode.`);
            return R.errorResponse(res, AUTH_FAIL, 401);
        }
        return next();
    }

    let tk;
    try {
        tk = tenant.getTenantKnex(u.db_name);   // factory does its own regex guard
        req.db = tk;                            // explicit handle (crudController + bridges)
    } catch (err) {
        console.error('tenantResolver: getTenantKnex failed:', err.message);
        return R.errorResponse(res, AUTH_FAIL, 401);
    }
    // Bind this tenant Knex as the active `db` for the WHOLE request so every
    // controller's module-level `db(...)` transparently hits the right tenant DB.
    return runWithTenant(tk, () => next());
}

module.exports = { resolveTenant };
