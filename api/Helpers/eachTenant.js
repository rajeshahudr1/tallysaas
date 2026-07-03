'use strict';

/**
 * api/Helpers/eachTenant.js
 *
 * Run a function once per ACTIVE licence, each time with that licence's tenant
 * Knex bound as the active `db` (AsyncLocalStorage). Background jobs have no
 * request context, so any code that touches tenant tables via the shared `db`
 * must run inside `runWithTenant`. This helper does that across every tenant.
 *
 *   await forEachTenant(async (licenseId, tdb) => {
 *       await db('einvoices').where(...)   // → this licence's tenant db
 *   });
 *
 * Failures on one licence are logged and skipped — one bad tenant never stops
 * the sweep. Licences are read from the MASTER control plane.
 */

const { db: masterDb } = require('../config/masterDb');
const { getKnexForLicense } = require('../config/tenantDb');
const { runWithTenant } = require('../config/db');

async function forEachTenant(fn) {
    let licenses = [];
    try {
        licenses = await masterDb('licenses')
            .whereNull('deleted_at').where('status', 'active').select('id');
    } catch (e) {
        console.error('[eachTenant] could not list licences:', e && e.message);
        return { total: 0, ok: 0, failed: 0 };
    }
    let ok = 0, failed = 0;
    for (const lic of licenses) {
        try {
            const tdb = getKnexForLicense(lic.id);
            await runWithTenant(tdb, () => fn(lic.id, tdb));
            ok += 1;
        } catch (e) {
            failed += 1;
            console.error(`[eachTenant] licence ${lic.id} error:`, e && e.message);
        }
    }
    return { total: licenses.length, ok, failed };
}

module.exports = { forEachTenant };
