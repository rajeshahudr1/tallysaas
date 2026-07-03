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

/**
 * Build a bridge middleware that binds a licence's tenant db (via runWithTenant)
 * when `pick(req)` yields a valid license id, else falls through to the
 * master/global pool. `pick` is where the licence id is carried — it differs by
 * route (an explicit ?license_id= vs a /licenses/:id/… path param).
 */
function makeBridge(pick) {
    return function bridge(req, res, next) {
        const licenseId = Number(pick(req));
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
    };
}

// Default: the target licence is carried EXPLICITLY as ?license_id / body
// .license_id / :license_id — screens that first PICK a licence, then act on its
// tenant data (GPS/GSP config, a licence's companies, its role permissions).
const superAdminBridge = makeBridge((req) =>
    (req.query && req.query.license_id)
    || (req.body && req.body.license_id)
    || (req.params && (req.params.license_id || req.params.licenseId)));

// Variant for /super-admin/licenses/:id/… routes where the route's OWN :id IS
// the licence (e.g. .../licenses/:id/reminders). Here :id is never a company /
// role id, so reading it as the licence is safe.
superAdminBridge.fromLicenseParam = makeBridge((req) => req.params && req.params.id);

module.exports = { superAdminBridge };
