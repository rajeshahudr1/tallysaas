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
    const hasOwn     = ownCompany !== null && ownCompany !== undefined;
    const hasLicense = user.license_id !== null && user.license_id !== undefined;

    // A user with NEITHER a company NOR a license is a misconfigured account.
    // (A license-admin legitimately has company_id NULL + a license_id — they
    //  are common to the WHOLE license and act on any company under it.)
    if (!hasOwn && !hasLicense) {
        return R.errorResponse(res, NO_COMPANY_MSG, 403);
    }

    // Is `id` a (non-deleted) company under THIS user's license?
    async function companyInLicense(id) {
        const company = await db('companies')
            .where('id', id).whereNull('deleted_at')
            .first('id', 'license_id');
        return (company && hasLicense &&
            Number(company.license_id) === Number(user.license_id))
            ? Number(company.id) : null;
    }

    try {
        // 1) Explicit header for the user's OWN company → trivially allowed.
        if (validRequest && hasOwn && requestedId === Number(ownCompany)) {
            req.companyId = Number(ownCompany);
            return next();
        }
        // 2) Any other valid header → honoured ONLY if that company is under
        //    the user's license (works for license-admins with no own company);
        //    a foreign id is silently ignored (no tenant escape).
        if (validRequest) {
            const ok = await companyInLicense(requestedId);
            if (ok) { req.companyId = ok; return next(); }
        }
        // 3) No usable header → the user's own company if they have one …
        if (hasOwn) { req.companyId = Number(ownCompany); return next(); }
        // 4) … otherwise (license-admin, no own company) → their license's FIRST
        //    company, so tenant pages show that company's data instead of nothing.
        const first = await db('companies')
            .where('license_id', user.license_id).whereNull('deleted_at')
            .orderBy('id').first('id');
        req.companyId = first ? Number(first.id) : null;
        return next();
    } catch (err) {
        console.error('resolveCompany license check error:', err);
        req.companyId = hasOwn ? Number(ownCompany) : null;
        return next();
    }
}

module.exports = {
    resolveCompany,
    NO_COMPANY_MSG,
};
