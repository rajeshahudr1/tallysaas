'use strict';

/**
 * api/Controllers/SuperAdmin/CompanyController.js
 *
 * Super-Admin company management. Today it exposes the per-company concurrent
 * WEB-session cap (companies.max_sessions_per_user) — "how many places ONE user
 * of this company may be signed in at once". Login enforces it with a
 * last-login-wins policy (oldest session evicted); Super Admin itself is exempt.
 *
 *   list             GET   /super-admin/companies
 *   setSessionLimit  PATCH /super-admin/companies/:id/session-limit
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

const MAX_LIMIT = 20;   // sane upper bound for concurrent sessions/user

async function list(req, res) {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = Math.min(100, parseInt(req.query.per_page, 10) || 50);

        const base = db('companies').whereNull('companies.deleted_at');
        const [{ count }] = await base.clone().count({ count: '*' });

        const rows = await base.clone()
            .leftJoin('licenses', 'licenses.id', 'companies.license_id')
            .select(
                'companies.id',
                'companies.name',
                'companies.status',
                'companies.license_id',
                'companies.max_sessions_per_user',
                'licenses.holder_name as license_holder',
                'licenses.key_prefix  as license_prefix',
            )
            .orderBy('companies.id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, {
            data: rows,
            meta: { total: Number(count), page, per_page: perPage },
        });
    } catch (err) {
        console.error('CompanyController.list error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

async function setSessionLimit(req, res) {
    try {
        const limit = parseInt(req.body.max_sessions_per_user, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            return R.errorResponse(res,
                `Session limit must be a whole number between 1 and ${MAX_LIMIT}.`, 422);
        }

        const company = await db('companies')
            .where('id', req.params.id).whereNull('deleted_at').first();
        if (!company) return R.errorResponse(res, 'Company not found.', 404);

        await db('companies').where('id', company.id)
            .update({ max_sessions_per_user: limit, updated_at: new Date() });

        return R.successResponse(res,
            { id: company.id, max_sessions_per_user: limit },
            'Session limit updated.');
    } catch (err) {
        console.error('CompanyController.setSessionLimit error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { list, setSessionLimit };
