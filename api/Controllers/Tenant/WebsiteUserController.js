'use strict';

/**
 * api/Controllers/Tenant/WebsiteUserController.js
 *
 * Website Users — third-party API users. A website user IS a customers row
 * (is_website_user = true) created FRESH from this screen (never picked from
 * the existing customer master), with:
 *   • a login user (customers.user_id — same dual-plane create as customer/
 *     sales-person logins, seat reconcile included),
 *   • an auto-generated api_token (`wt_<licenseId>_<40 hex>`) for the /ext/*
 *     third-party endpoints — regenerable, shown in full to admins,
 *   • cash_extra_pct / online_extra_pct — payment-mode surcharges the invoice
 *     pricing applies ON TOP of the category discount/addition rate,
 *   • the SAME catalog assignment as customer users (customer_user_categories /
 *     _products via PUT /customers/:id/catalog — a website user is a customer).
 *
 * Because the login is linked via customers.user_id, everything the customer-
 * portal does (scoped products/categories, forced customer_id, locked rates,
 * approval queue, dashboard) works for a website-user login with NO extra code.
 *
 * Handlers: { list, get, create, update, regenerateToken }.
 */

const crypto = require('node:crypto');
const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { hash } = require('../../Helpers/passwords');
const { EMAIL_TAKEN_MSG } = require('../../Helpers/emailUnique');
const { emailTakenAcrossPlanes, createLicensedUser, patchLicensedUser } = require('../../Helpers/tenantUsers');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Website user not found.';

/** Mint a fresh api token. The licence id prefix lets the /ext/* middleware
 * find the right tenant DB from the token alone. */
function mintToken(licenseId) {
    return `wt_${Number(licenseId)}_${crypto.randomBytes(20).toString('hex')}`;
}

// Company-scoped, non-deleted WEBSITE-USER customer row or null.
async function fetchWebsiteUser(companyId, id) {
    return db('customers')
        .where('company_id', companyId)
        .where('id', id)
        .where('is_website_user', true)
        .whereNull('deleted_at')
        .first();
}

// Role-assignability policy (same as user/sales-person/customer-user creates).
async function assignableRole(req, roleId) {
    const isSuper = req.user && req.user.role_slug === 'super-admin';
    const licenseId = (req.user && req.user.license_id) || null;
    const role = await db('roles').where('id', roleId)
        .first('id', 'slug', 'is_system', 'license_id');
    if (!role) return null;
    if (!isSuper) {
        const ok = !['super-admin', 'company-admin'].includes(role.slug)
            && ((role.is_system && role.license_id == null) || role.license_id === licenseId);
        if (!ok) return null;
    }
    return role;
}

/** GET /api/v1/website-users — paginated list (search on name/email/mobile). */
async function list(req, res) {
    try {
        let page    = parseInt(req.query.page, 10);     if (!Number.isInteger(page) || page < 1) page = 1;
        let perPage = parseInt(req.query.per_page, 10); if (!Number.isInteger(perPage) || perPage < 1) perPage = 20;
        if (perPage > 100) perPage = 100;
        const search = (req.query.search || '').trim();

        let qb = db('customers as c')
            .leftJoin('users as u', 'u.id', 'c.user_id')
            .where('c.company_id', req.companyId)
            .where('c.is_website_user', true)
            .whereNull('c.deleted_at');
        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('c.name', 'ilike', like)
                 .orWhere('c.email', 'ilike', like)
                 .orWhere('c.mobile', 'ilike', like);
            });
        }
        if (req.query.status) qb = qb.where('c.status', req.query.status);

        const totalRow = await qb.clone().clearSelect().count('c.id as t').first();
        const rows = await qb
            .orderBy('c.id', 'desc')
            .offset((page - 1) * perPage).limit(perPage)
            .select('c.*', 'u.email as login_email', 'u.status as login_status', 'u.role_id as login_role_id');

        return R.successResponse(res, {
            data: rows,
            meta: { total: Number(totalRow ? totalRow.t : 0), page, per_page: perPage },
        });
    } catch (err) {
        console.error('websiteUsers.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /api/v1/website-users/:id — full row incl. token + linked login. */
async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const wu = await fetchWebsiteUser(req.companyId, id);
        if (!wu) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        let login = null;
        if (wu.user_id) {
            const u = await db('users').where('id', wu.user_id).whereNull('deleted_at')
                .first('id', 'email', 'role_id', 'status');
            if (u) login = u;
        }
        return R.successResponse(res, { ...wu, login });
    } catch (err) {
        console.error('websiteUsers.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /api/v1/website-users
 * Create the customer row (is_website_user + token) AND the login in one flow.
 */
async function create(req, res) {
    try {
        const b = req.body;
        const licenseId = (req.user && req.user.license_id) || null;

        const role = await assignableRole(req, b.role_id);
        if (!role) return R.errorResponse(res, 'You cannot assign that role.', 422);

        const taken = await emailTakenAcrossPlanes(b.email, licenseId, {});
        if (taken) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);

        const now = new Date();
        // 1. The login (dual-plane + seat reconcile) — same as other logins.
        const password_hash = await hash(b.password);
        const linked = await createLicensedUser({
            company_id:      req.companyId,
            license_id:      licenseId,
            role_id:         b.role_id,
            name:            b.name,
            email:           b.email,
            mobile:          b.mobile || null,
            password_hash,
            status:          b.status || 'Active',
            location_id:     null,
            approval_status: 'approved',
            approved_at:     now,
            approved_by:     req.user ? req.user.sub : null,
        }, role.slug, ['id', 'email', 'role_id', 'status']);

        // 2. The website-user customer row, linked to that login + fresh token.
        const [cust] = await db('customers').insert({
            company_id:       req.companyId,
            name:             b.name,
            email:            b.email,
            mobile:           b.mobile || null,
            status:           b.status || 'Active',
            is_website_user:  true,
            api_token:        mintToken(licenseId),
            cash_extra_pct:   b.cash_extra_pct || 0,
            online_extra_pct: b.online_extra_pct || 0,
            user_id:          linked.id,
            // A website user is an API/portal party, not a Tally master by
            // default — flip in the customer master later if needed.
            is_tally_ledger:  true,
            created_at:       now,
            updated_at:       now,
        }).returning('*');

        const msg = linked.status === 'Active'
            ? 'Website user created. Share the API token for third-party access.'
            : 'Website user created but the login is inactive — the license seat limit is reached.';
        return R.successResponse(res, { ...cust, login: linked }, msg);
    } catch (err) {
        console.error('websiteUsers.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** PUT /api/v1/website-users/:id — patch profile / % / login. */
async function update(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const b = req.body;
        const licenseId = (req.user && req.user.license_id) || null;
        const wu = await fetchWebsiteUser(req.companyId, id);
        if (!wu) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        // Customer-row patch.
        const patch = { updated_at: new Date() };
        for (const k of ['name', 'mobile', 'status']) {
            if (Object.prototype.hasOwnProperty.call(b, k)) patch[k] = b[k];
        }
        if (b.cash_extra_pct   != null) patch.cash_extra_pct   = b.cash_extra_pct;
        if (b.online_extra_pct != null) patch.online_extra_pct = b.online_extra_pct;
        if (b.email) patch.email = b.email;
        await db('customers').where('id', wu.id).update(patch);

        // Login patch (role / email / status / optional password).
        if (wu.user_id && (b.role_id || b.email || b.password || b.status)) {
            if (b.role_id) {
                const role = await assignableRole(req, b.role_id);
                if (!role) return R.errorResponse(res, 'You cannot assign that role.', 422);
            }
            if (b.email) {
                const linked = await db('users').where('id', wu.user_id).first('id', 'email');
                if (linked && b.email !== linked.email) {
                    const clash = await emailTakenAcrossPlanes(b.email, licenseId, { exceptUserId: linked.id });
                    if (clash) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
                }
            }
            const uPatch = { updated_at: new Date() };
            if (b.role_id)  uPatch.role_id = b.role_id;
            if (b.email)    uPatch.email = b.email;
            if (b.status)   uPatch.status = b.status;
            if (b.password) uPatch.password_hash = await hash(b.password);
            await patchLicensedUser(wu.user_id, licenseId, () => uPatch, { reconcile: !!b.status });
        }

        const fresh = await fetchWebsiteUser(req.companyId, id);
        return R.successResponse(res, fresh, 'Website user updated.');
    } catch (err) {
        console.error('websiteUsers.update error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /api/v1/website-users/:id/regenerate-token — rotate the API token.
 * The old token stops working IMMEDIATELY. Returns the new full token. */
async function regenerateToken(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const wu = await fetchWebsiteUser(req.companyId, id);
        if (!wu) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        const licenseId = (req.user && req.user.license_id) || null;
        const api_token = mintToken(licenseId);
        await db('customers').where('id', wu.id).update({ api_token, updated_at: new Date() });
        return R.successResponse(res, { id: wu.id, api_token }, 'API token regenerated.');
    } catch (err) {
        console.error('websiteUsers.regenerateToken error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, update, regenerateToken };
