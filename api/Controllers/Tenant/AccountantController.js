'use strict';

/**
 * api/Controllers/Tenant/AccountantController.js
 *
 * "Share with your CA / Accountant" — a one-tap way for a company to give its
 * accountant SAFE, read-only access to the books, more polished than a manual
 * Users + Roles setup.
 *
 *   invite  POST   /account/accountants        ({name, email, password})
 *           → ensures a curated, read-only "Accountant" role (view + export on
 *             the financial modules, filtered to the licence's entitlements) and
 *             creates the login under it. Idempotent role: reused across invites.
 *   list    GET    /account/accountants        → every accountant login + status
 *   revoke  DELETE /account/accountants/:id     → flip the login to Inactive
 *
 * Security: licence-scoped (req.user.license_id). Duplicate-email guarded; the
 * Accountant role can only hold permissions the licence is ENTITLED to, so a CA
 * can never see/grant beyond the plan. Seats reconcile exactly like Users.
 */

const R            = require('../../Helpers/response');
const db           = require('../../config/db').db;
const entitlements = require('../../Helpers/entitlements');
const { hash }     = require('../../Helpers/passwords');
const { EMAIL_TAKEN_MSG } = require('../../Helpers/emailUnique');
const { emailTakenAcrossPlanes, createLicensedUser, patchLicensedUser } = require('../../Helpers/tenantUsers');
const { sendAccountantInvite } = require('../../Helpers/mail');

const OOPS = 'Oops..Something went wrong. Please try again.';

// The curated, read-only access a CA actually needs — VIEW + EXPORT only (never
// create/edit/delete), across the financial + master modules. Admin areas
// (settings, users, roles, companies, tally-sync) are intentionally excluded.
const ACCOUNTANT_MODULES = [
    'dashboard', 'customers', 'suppliers', 'products', 'categories', 'locations',
    'sales-persons', 'sales-invoices', 'purchase-invoices', 'payments', 'receipts',
    'journals', 'inventory', 'reports',
];
const ACCOUNTANT_ACTIONS = ['view', 'export'];

/** Find (or create once) this licence's read-only "Accountant" role; return id.
 * Permissions are filtered to the licence's entitlements so a CA never exceeds
 * the plan. Reused across invites (one Accountant role per licence). */
async function ensureAccountantRole(licenseId) {
    const existing = await db('roles')
        .where({ license_id: licenseId, slug: 'accountant', is_system: false })
        .whereNull('company_id')
        .first('id');
    if (existing) return existing.id;

    const entitled = new Set(await entitlements.licensePermissionSlugs(licenseId));
    const wanted = [];
    for (const m of ACCOUNTANT_MODULES) {
        for (const a of ACCOUNTANT_ACTIONS) {
            const slug = `${m}.${a}`;
            if (entitled.has(slug)) wanted.push(slug);
        }
    }
    const permRows = wanted.length
        ? await db('permissions').whereIn('slug', wanted).select('id') : [];

    const role = await db.transaction(async (trx) => {
        const [r] = await trx('roles')
            .insert({ license_id: licenseId, company_id: null, name: 'Accountant', slug: 'accountant', is_system: false })
            .returning(['id']);
        if (permRows.length) {
            await trx('role_permissions').insert(permRows.map((p) => ({ role_id: r.id, permission_id: p.id })));
        }
        return r;
    });
    return role.id;
}

async function invite(req, res) {
    try {
        const licenseId = (req.user && req.user.license_id) || null;
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can invite an accountant.', 422);
        }
        const name  = String(req.body.name || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');

        if (await emailTakenAcrossPlanes(email, licenseId)) {
            return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
        }

        // Role: the company MAY pick any role they can assign (their own custom
        // roles); if none is chosen, fall back to the safe auto "Accountant" role.
        // roleSlug is denormalised onto the master login (auth).
        let roleId;
        let roleSlug;
        const picked = Number(req.body.role_id);
        if (Number.isInteger(picked) && picked > 0) {
            const role = await db('roles').where('id', picked)
                .first('id', 'slug', 'is_system', 'license_id');
            const assignable = role
                && !['super-admin', 'company-admin'].includes(role.slug)
                && ((role.is_system && role.license_id == null) || role.license_id === licenseId);
            if (!assignable) return R.errorResponse(res, 'You cannot assign that role.', 422);
            roleId = picked;
            roleSlug = role.slug;
        } else {
            roleId = await ensureAccountantRole(licenseId);
            roleSlug = 'accountant';
        }
        const password_hash = await hash(password);
        const now = new Date();
        const row = {
            company_id:      req.companyId,
            license_id:      licenseId,
            role_id:         roleId,
            name,
            email,
            password_hash,
            status:          'Active',
            approval_status: 'approved',
            approved_at:     now,
            approved_by:     req.user ? req.user.sub : null,
        };

        // Dual-write the login: MASTER (auth, role_slug) + same-id TENANT mirror,
        // then reconcile the licence seats (an over-cap invite lands Inactive).
        const inserted = await createLicensedUser(
            row, roleSlug, ['id', 'name', 'email', 'status', 'created_at'],
        );

        // Fire the invite email in the BACKGROUND — non-blocking, so the API
        // responds instantly; an email/SMTP failure never breaks the invite (the
        // login already exists, and the password is shown to the inviter too).
        db('companies').where('id', req.companyId).first('name')
            .then((c) => sendAccountantInvite(email, { name, companyName: c && c.name, email, password }))
            .catch((e) => console.error('accountant invite email failed:', e && e.message));

        const msg = inserted.status === 'Active'
            ? 'Accountant invited — an email with the sign-in details is on its way to them.'
            : 'Accountant invited but INACTIVE — the licence seat limit is reached. Raise the plan (max_users) to activate them.';
        return R.successResponse(res, inserted, msg);
    } catch (err) {
        // Unique-violation (Postgres 23505) on the email = the address is already
        // taken (e.g. by a still-present soft-deleted row) — show the clear
        // "email in use" message instead of a generic 500 "Oops".
        if (err && err.code === '23505') {
            return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
        }
        console.error('accountants.invite error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function list(req, res) {
    try {
        const rows = await db('users')
            .join('roles', 'roles.id', 'users.role_id')
            .where('users.company_id', req.companyId)
            .whereNotIn('roles.slug', ['company-admin', 'super-admin'])
            .whereNull('users.deleted_at')
            .select('users.id', 'users.name', 'users.email', 'users.status',
                'users.last_login_at', 'users.created_at', 'roles.name as role', 'roles.id as role_id')
            .orderBy('users.id', 'desc');
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('accountants.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function revoke(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, 'Accountant not found.', 404);
        // Must be an accountant of THIS company (defence-in-depth + 404 on miss).
        const u = await db('users as u')
            .join('roles as r', 'r.id', 'u.role_id')
            .where({ 'u.id': id, 'u.company_id': req.companyId })
            .whereNotIn('r.slug', ['company-admin', 'super-admin'])
            .whereNull('u.deleted_at')
            .first('u.id');
        if (!u) return R.errorResponse(res, 'Accountant not found.', 404);
        // Soft-delete so the row LEAVES the list (the list filters deleted_at) and
        // the licence seat is freed; reconcile in the same txn.
        const now = new Date();
        const lic = (req.user && req.user.license_id) || null;
        // Soft-delete the login on BOTH planes (master auth + tenant mirror) so the
        // CA can no longer sign in AND leaves the tenant list, then reconcile seats
        // (frees the seat). Email is tombstoned per-plane so it can be re-invited.
        await patchLicensedUser(id, lic, (k) => ({
            status: 'Inactive',
            deleted_at: now,
            // The users_email_unique index counts soft-deleted rows too, so
            // tombstone the address (concat keeps it unique + auditable).
            email: k.raw("concat(email, '#revoked-', id)"),
            updated_at: now,
        }));
        return R.successResponse(res, { id }, 'Accountant access revoked.');
    } catch (err) {
        console.error('accountants.revoke error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { invite, list, revoke };
