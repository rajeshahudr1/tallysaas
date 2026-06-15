'use strict';

/**
 * api/Controllers/Tenant/CompanyController.js
 *
 * Tenant company management (distinct from SuperAdmin/CompanyController, which
 * only sets the session cap). A company is registered UNDER the caller's
 * license:
 *   • list   GET  /companies — companies the caller may see (super-admin = all,
 *                              else those under their license_id).
 *   • create POST /companies — register a new company under the caller's
 *                              license, enforcing the license's max_companies
 *                              cap + a unique slug.
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

const OOPS_MSG  = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

function slugify(s) {
    return String(s || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110) || 'company';
}

async function uniqueSlug(name) {
    const base = slugify(name);
    let slug = base, n = 1;
    // Append -2, -3… until free. Bounded loop; collisions are rare.
    // eslint-disable-next-line no-await-in-loop
    while (await db('companies').where('slug', slug).first('id')) { slug = `${base}-${++n}`; }
    return slug;
}

async function list(req, res) {
    try {
        const user = req.user || {};
        let page    = parseInt(req.query.page, 10);
        let perPage = parseInt(req.query.per_page, 10);
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
        if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;

        let base = db('companies').whereNull('companies.deleted_at');
        if (user.role_slug !== 'super-admin') {
            base = base.where('companies.license_id', user.license_id != null ? user.license_id : -1);
        }
        if (req.query.status) base = base.where('companies.status', req.query.status);
        if (req.query.search) {
            const like = `%${String(req.query.search).trim()}%`;
            base = base.where((b) => {
                b.where('companies.name', 'ilike', like)
                    .orWhere('companies.email', 'ilike', like)
                    .orWhere('companies.gst_number', 'ilike', like);
            });
        }

        const [{ count }] = await base.clone().count({ count: '*' });
        const rows = await base.clone()
            .select('id', 'name', 'email', 'mobile', 'gst_number', 'pan_number',
                    'financial_year', 'status', 'created_at')
            .orderBy('id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, {
            data: rows,
            meta: { total: Number(count), page, per_page: perPage },
        });
    } catch (err) {
        console.error('CompanyController.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const b = req.body;
        const licenseId = req.user && req.user.license_id;
        if (licenseId == null) {
            return R.errorResponse(res, 'Your account is not linked to a license, so it cannot register companies.', 422);
        }

        // Enforce the license's company cap.
        const lic = await db('licenses').where('id', licenseId).whereNull('deleted_at')
            .first('max_companies', 'status');
        if (!lic) return R.errorResponse(res, 'Your license could not be found.', 422);
        if (lic.status && lic.status !== 'active') {
            return R.errorResponse(res, `Your license is ${lic.status}; cannot add companies.`, 403);
        }
        const [{ count }] = await db('companies')
            .where('license_id', licenseId).whereNull('deleted_at').count({ count: '*' });
        if (lic.max_companies != null && Number(count) >= Number(lic.max_companies)) {
            return R.errorResponse(res,
                `Company limit reached for your license (max ${lic.max_companies}). Contact your administrator to raise it.`, 422);
        }

        const row = {
            name:           b.name,
            slug:           await uniqueSlug(b.name),
            email:          b.email || null,
            mobile:         b.mobile || null,
            gst_number:     b.gst_number || null,
            pan_number:     b.pan_number || null,
            financial_year: b.financial_year || null,
            address:        b.address || null,
            status:         b.status || 'Active',
            license_id:     licenseId,
        };
        const [created] = await db('companies').insert(row)
            .returning(['id', 'name', 'slug', 'status']);
        return R.successResponse(res, created, 'Company created.');
    } catch (err) {
        console.error('CompanyController.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, create };
