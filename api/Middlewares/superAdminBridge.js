'use strict';

/**
 * api/Middlewares/superAdminBridge.js
 *
 * Super Admin cross-tenant bridge. Some platform screens edit data that now
 * lives in a LICENCE'S tenant db (per-license GPS/GSP/reminder config, a
 * licence's companies, a licence's role permissions). The super-admin has no
 * db_name of their own, so those routes explicitly carry the target
 * `license_id` (query / body / route param); this middleware binds THAT
 * licence's tenant Knex for the request via runWithTenant, so the controller's
 * `db(...)` calls hit the right tenant db.
 *
 * When no license_id is present (e.g. a list-before-choose screen), it falls
 * through — the controller runs against the master/global pool as before.
 *
 * Mount AFTER authenticate + requireSuperAdmin, BEFORE the controller.
 */

const R = require('../Helpers/response');
const { getTenantKnex, dbNameForLicense } = require('../config/tenantDb');
const { runWithTenant } = require('../config/db');

function superAdminBridge(req, res, next) {
    const raw = (req.query && req.query.license_id)
        || (req.body && req.body.license_id)
        || (req.params && (req.params.license_id || req.params.licenseId));
    const licenseId = Number(raw);
    if (!Number.isInteger(licenseId) || licenseId <= 0) {
        return next();   // no licence chosen yet → master/global
    }
    let tk;
    try {
        tk = getTenantKnex(dbNameForLicense(licenseId));
        req.db = tk;
        req.bridgeLicenseId = licenseId;
    } catch (err) {
        return R.errorResponse(res, 'Invalid licence.', 400);
    }
    return runWithTenant(tk, () => next());
}

module.exports = { superAdminBridge };
