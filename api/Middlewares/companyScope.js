'use strict';

/**
 * api/Middlewares/companyScope.js
 *
 * Resolves the effective tenant id for the request and pins it to
 * `req.companyId`. Every tenant-scoped query (via the crudController factory)
 * reads `req.companyId` — this middleware is the single place that decides it.
 *
 * Rules (spec §4 + licensing model):
 *   • Super Admin (role_slug === 'super-admin') may operate ACROSS companies.
 *     An `X-Company-Id` header targets that company; without it, req.companyId
 *     is null (cross-company list endpoints handle null explicitly).
 *   • Regular users are COMMON TO A LICENSE, so they may act on ANY company
 *     under their own license. An `X-Company-Id` is honoured only after we
 *     confirm the requested company belongs to the user's license_id — any
 *     other id is a cross-tenant escape attempt and is ignored (falls back to
 *     their primary company). No header → their primary `company_id`.
 *   • A non-super-admin with no company_id is a misconfigured account → 403.
 *
 * Must run AFTER auth.authenticate (it reads req.user). Async — the license
 * check is a single indexed lookup.
 */

const R  = require('../Helpers/response');
const db = require('../config/db').db;

const NO_COMPANY_MSG = 'No company is associated with your account.';

async function resolveCompany(req, res, next) {
    const user = req.user || {};
    const header = req.headers['x-company-id'];
    const requestedId = (header !== undefined && header !== '') ? Number(header) : null;
    const validRequest = Number.isInteger(requestedId) && requestedId > 0;

    if (user.role_slug === 'super-admin') {
        // Super Admin may target any company via header; otherwise null.
        req.companyId = validRequest ? requestedId : null;
        return next();
    }

    const ownCompany = user.company_id;
    if (ownCompany === null || ownCompany === undefined) {
        return R.errorResponse(res, NO_COMPANY_MSG, 403);
    }

    // No (or blank/own) header → their primary company. No DB hit needed.
    if (!validRequest || requestedId === Number(ownCompany)) {
        req.companyId = Number(ownCompany);
        return next();
    }

    // A DIFFERENT company was requested — allow ONLY if it shares the user's
    // license; otherwise silently fall back to their own (no tenant escape).
    try {
        const company = await db('companies')
            .where('id', requestedId).whereNull('deleted_at')
            .first('id', 'license_id');
        const sameLicense = company && user.license_id != null &&
            Number(company.license_id) === Number(user.license_id);
        req.companyId = sameLicense ? requestedId : Number(ownCompany);
        return next();
    } catch (err) {
        console.error('resolveCompany license check error:', err);
        req.companyId = Number(ownCompany);
        return next();
    }
}

module.exports = {
    resolveCompany,
    NO_COMPANY_MSG,
};
