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

const AUTH_FAIL = 'Authentication failed. Please log in again.';

function resolveTenant(req, res, next) {
    const u = req.user;
    if (!u || typeof u !== 'object') return R.errorResponse(res, AUTH_FAIL, 401);

    // Super-admin (or any token without a tenant db) can't hit tenant routes.
    if (u.role_slug === 'super-admin' || !u.db_name || typeof u.db_name !== 'string') {
        return R.errorResponse(res, AUTH_FAIL, 401);
    }

    try {
        req.db = tenant.getTenantKnex(u.db_name);   // factory does its own regex guard
    } catch (err) {
        console.error('tenantResolver: getTenantKnex failed:', err.message);
        return R.errorResponse(res, AUTH_FAIL, 401);
    }
    return next();
}

module.exports = { resolveTenant };
