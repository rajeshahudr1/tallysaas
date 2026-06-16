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
        let qb = db('companies')
            .whereNull('deleted_at')
            .select('id', 'name', 'license_id')
            .orderBy('name', 'asc');

        // Regular users are scoped to their license; Super Admin sees all,
        // but may narrow to ONE license via ?license_id= (drives the super
        // admin's License→Company two-level switcher).
        if (user.role_slug !== 'super-admin') {
            qb = qb.where('license_id', user.license_id != null ? user.license_id : -1);
        } else if (req.query.license_id != null && req.query.license_id !== '') {
            const lid = Number(req.query.license_id);
            if (Number.isInteger(lid) && lid > 0) qb = qb.where('license_id', lid);
        }

        const rows = await qb;
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
