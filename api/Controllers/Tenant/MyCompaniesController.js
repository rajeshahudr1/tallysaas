'use strict';

/**
 * api/Controllers/Tenant/MyCompaniesController.js
 *
 * GET /my-companies — the companies the signed-in user may switch between
 * (backs the header company switcher). Users are common to a LICENSE, so a
 * regular user sees every company under their license; the Super Admin sees
 * all companies. Returns the standard { data, meta } envelope (fetchOptions
 * on the web side consumes {id,name}).
 *
 * Runs behind `authenticate` only (NOT resolveCompany — this lists companies,
 * it doesn't act within one).
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

async function list(req, res) {
    try {
        const user = req.user || {};

        // Super Admin is platform-only — they own NO companies (no company
        // switcher). They MAY narrow to one licence's companies via ?license_id=
        // (that licence's OWN tenant db); with no license_id there is nothing.
        if (user.role_slug === 'super-admin') {
            const raw = req.query.license_id;
            const lid = Number(raw);
            if (raw == null || raw === '' || !Number.isInteger(lid) || lid <= 0) {
                return R.successResponse(res, { data: [], meta: { total: 0, page: 1, per_page: 0 } });
            }
            const tdb = require('../../config/tenantDb').getKnexForLicense(lid);
            const rows = await tdb('companies')
                .whereNull('deleted_at').where('license_id', lid)
                .select('id', 'name', 'license_id', 'tally_synced_at', 'tally_dirty')
                .orderBy('name', 'asc');
            return R.successResponse(res, {
                data: rows, meta: { total: rows.length, page: 1, per_page: rows.length },
            });
        }

        // Regular user: companies live in the caller's tenant db (bound by
        // resolveTenant), scoped to their license.
        const rows = await db('companies as c')
            .whereNull('c.deleted_at')
            .where('c.license_id', user.license_id != null ? user.license_id : -1)
            // Sync state lives in its own table (one row per company) — joined
            // here so the switcher's "Company Information" panel can show the
            // real last pull/push without a second round trip.
            .leftJoin('tally_sync_state as ss', 'ss.company_id', 'c.id')
            // tally_synced_at / tally_dirty back the switcher's "Synced 4 days
            // ago" caption — the agent stamps them on every successful pull.
            .select('c.id', 'c.name', 'c.license_id', 'c.tally_synced_at', 'c.tally_dirty',
                'c.books_from', 'c.financial_year', 'c.created_at',
                'ss.last_pull_at', 'ss.last_push_at')
            .orderBy('c.name', 'asc');
        return R.successResponse(res, {
            data: rows,
            meta: { total: rows.length, page: 1, per_page: rows.length },
        });
    } catch (err) {
        console.error('MyCompaniesController.list error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { list };
