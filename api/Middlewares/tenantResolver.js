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
 */

const R      = require('../Helpers/response');
const tenant = require('../config/tenantDb');
const { runWithTenant } = require('../config/db');

const AUTH_FAIL = 'Authentication failed. Please log in again.';

function resolveTenant(req, res, next) {
    const u = req.user;
    if (!u || typeof u !== 'object') return R.errorResponse(res, AUTH_FAIL, 401);

    // TRANSITION-TOLERANT: until the flip, JWTs carry no `db_name` — fall through
    // so `db(...)` uses the global (old single-DB) fallback and the app keeps
    // working. Super-admin also falls through (they use the global master pool /
    // an explicit super-admin bridge, never a single tenant db). Post-flip, when
    // every token carries db_name, the else-branch below always runs.
    // (To make this STRICT after the flip, reject when !u.db_name.)
    if (u.role_slug === 'super-admin' || !u.db_name || typeof u.db_name !== 'string') {
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
