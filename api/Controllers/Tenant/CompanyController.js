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
                // Search across EVERY user-facing column (not just name/email/gst).
                for (const col of ['name', 'mailing_name', 'email', 'mobile', 'phone',
                    'gst_number', 'pan_number', 'state', 'country', 'pincode',
                    'address', 'financial_year']) {
                    b.orWhere(`companies.${col}`, 'ilike', like);
                }
            });
        }

        const [{ count }] = await base.clone().count({ count: '*' });
        // Sortable UI keys → DB columns (?sort=<key>&order=asc|desc). Unknown
        // keys fall back to newest-first.
        const SORT_MAP = {
            name: 'name', gst: 'gst_number', pan: 'pan_number', mobile: 'mobile',
            email: 'email', financial_year: 'financial_year', status: 'status', created_at: 'created_at',
        };
        const sortKey = String(req.query.sort || '').trim();
        const order   = String(req.query.order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
        let rowsQb = base.clone()
            .select('id', 'name', 'mailing_name', 'email', 'mobile', 'phone',
                    'gst_number', 'pan_number', 'state', 'country', 'pincode', 'address',
                    'financial_year', 'books_from', 'logo', 'status', 'custom_fields', 'created_at')
            .limit(perPage).offset((page - 1) * perPage);
        if (SORT_MAP[sortKey]) {
            rowsQb = rowsQb.orderBy(`companies.${SORT_MAP[sortKey]}`, order).orderBy('companies.id', 'desc');
        } else {
            rowsQb = rowsQb.orderBy('companies.id', 'desc');
        }
        const rows = await rowsQb;

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

/** GET /companies/:id — one company (license-scoped) for the edit form. */
async function get(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const company = await db('companies').where({ id: req.params.id })
            .modify((q) => { if (licenseId != null) q.where('license_id', licenseId); })
            .whereNull('deleted_at')
            .first('id', 'name', 'slug', 'email', 'mobile', 'phone', 'gst_number', 'pan_number',
                'mailing_name', 'state', 'country', 'pincode', 'financial_year', 'books_from',
                'address', 'logo', 'status', 'custom_fields');
        if (!company) return R.errorResponse(res, 'Company not found.', 404);
        return R.successResponse(res, company);
    } catch (err) {
        console.error('CompanyController.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** PUT /companies/:id — update an editable company (license-scoped). The agent
 *  only FILLS EMPTY Tally-synced fields, so the user can override any field here
 *  without it being clobbered on the next sync. */
async function update(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = req.params.id;
        const owned = await db('companies').where({ id })
            .modify((q) => { if (licenseId != null) q.where('license_id', licenseId); })
            .whereNull('deleted_at').first('id');
        if (!owned) return R.errorResponse(res, 'Company not found.', 404);
        const b = req.body;
        const patch = { updated_at: new Date() };
        for (const f of ['name', 'email', 'mobile', 'phone', 'gst_number', 'pan_number',
            'mailing_name', 'state', 'country', 'pincode', 'financial_year', 'books_from',
            'address', 'logo', 'status']) {
            if (Object.prototype.hasOwnProperty.call(b, f)) patch[f] = b[f] || null;
        }
        if (patch.name === null) delete patch.name;   // name stays required
        // Custom Fields bag (key/value) → JSONB.
        if (b.custom_fields && typeof b.custom_fields === 'object') {
            patch.custom_fields = JSON.stringify(b.custom_fields);
        }
        await db('companies').where({ id }).update(patch);
        const fresh = await db('companies').where({ id }).first('id', 'name', 'slug', 'status');
        return R.successResponse(res, fresh, 'Company updated.');
    } catch (err) {
        console.error('CompanyController.update error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** DELETE /companies/:id — soft-delete a company (license-scoped). */
async function destroy(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = req.params.id;
        const owned = await db('companies').where({ id })
            .modify((q) => { if (licenseId != null) q.where('license_id', licenseId); })
            .whereNull('deleted_at').first('id');
        if (!owned) return R.errorResponse(res, 'Company not found.', 404);
        await db('companies').where({ id }).update({ deleted_at: new Date(), updated_at: new Date() });
        return R.successResponse(res, { id }, 'Company deleted.');
    } catch (err) {
        console.error('CompanyController.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, create, get, update, destroy };
