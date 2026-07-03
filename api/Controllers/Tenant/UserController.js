'use strict';

/**
 * api/Controllers/Tenant/UserController.js
 *
 * Custom tenant controller for the `users` table. NOT wired through
 * Helpers/crudController because creation is bespoke: it hashes a password
 * (Helpers/passwords) into password_hash, rejects duplicate emails, and stamps
 * company_id / license_id from the authenticated caller rather than the body.
 *
 *   • list  — GET  /users : company-scoped, soft-delete aware, joined to roles
 *             for a friendly `role` label. Free-text search on name/email/mobile;
 *             filters on status and role_id. Returns the { data, meta } envelope
 *             every list endpoint emits.
 *   • create— POST /users : validated body. Duplicate-email guard (company-scoped
 *             OR global, since a login email must be unique across the install).
 *             password_hash derived from the plaintext password; the created row
 *             is returned WITHOUT password_hash.
 *
 * Conventions: company-scoped by req.companyId (resolveCompany), whereNull
 * deleted_at on reads, every handler async + try/catch → console.error + 500
 * envelope.
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const { hash } = require('../../Helpers/passwords');
const { reconcileLicenseSeats } = require('../../Helpers/seats');
const { emailInUse, EMAIL_TAKEN_MSG } = require('../../Helpers/emailUnique');

const OOPS_MSG       = 'Oops..Something went wrong. Please try again.';
const DUP_EMAIL_MSG  = 'A user with this email already exists.';

// Pagination bounds — mirror crudController so list shapes match everywhere.
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

// Columns returned by list — base user fields plus the friendly role label.
const LIST_COLUMNS = [
    'users.id',
    'users.name',
    'users.email',
    'users.mobile',
    'roles.name as role',
    'users.status',
    'users.approval_status',
    'users.last_login_at',
    'users.created_at',
];

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

/**
 * GET /api/v1/users
 * Company-scoped list of users with the role label joined in. Search spans
 * name / email / mobile; status and role_id narrow further.
 */
async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search = (req.query.search || '').trim();
        const status = (req.query.status || '').trim();
        const roleId = req.query.role_id;

        let qb = db('users')
            .leftJoin('roles', 'roles.id', 'users.role_id')
            .where('users.company_id', req.companyId)
            .whereNull('users.deleted_at');

        // Per-user location scoping (Requirement C): users carry location_id, so
        // a location-restricted admin sees only the users pinned to their own
        // location; unrestricted (req.locationId null) → all company users.
        if (req.locationId != null) qb = qb.where('users.location_id', req.locationId);

        if (status) qb = qb.where('users.status', status);
        if (roleId) qb = qb.where('users.role_id', roleId);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('users.name', 'ilike', like)
                    .orWhere('users.email', 'ilike', like)
                    .orWhere('users.mobile', 'ilike', like);
            });
        }

        // Count BEFORE pagination — clone so offset/limit/select/order don't
        // leak into the count query.
        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('users.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('users.id', 'desc')
            .select(...LIST_COLUMNS);

        return R.successResponse(res, {
            data: rows,
            meta: { total, page, per_page: perPage },
        });
    } catch (err) {
        console.error('users.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /api/v1/users
 * Creates a tenant user. Rejects a duplicate email (company-scoped OR global,
 * since the email is the login identity). Hashes the plaintext password and
 * returns the created row without password_hash.
 */
async function create(req, res) {
    try {
        const body  = req.body;
        const email = body.email;

        // Duplicate-email guard. The email is the login identity, so it must be
        // unique across the whole install — across BOTH users AND sales_persons
        // (one email = one person). Ignore soft-deleted rows so a previously
        // removed email can be reused.
        // Email is the LOGIN identity → unique across the whole install. Check
        // master.users (every licence's logins) AND the tenant (its sales_persons).
        const emailMaster = await require('../../config/masterDb').db('users')
            .whereRaw('lower(email) = ?', [String(email).toLowerCase()]).whereNull('deleted_at').first('id');
        if (emailMaster || await emailInUse(db, email, {})) {
            return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
        }

        // Enforce the assignable-role policy server-side (the UI dropdown is not a
        // security boundary): a tenant may assign a global SYSTEM role EXCEPT the
        // platform/admin roles (super-admin, company-admin), or one of THEIR OWN
        // license's custom roles — nothing else. Super Admin (no license) bypasses.
        const isSuper = req.user && req.user.role_slug === 'super-admin';
        const licenseIdForRole = (req.user && req.user.license_id) || null;
        // Roles live in the TENANT db (via als). Fetch the assigned role so we can
        // BOTH policy-check it AND denormalise its slug onto the master.users row.
        const role = await db('roles').where('id', body.role_id)
            .first('id', 'slug', 'is_system', 'license_id');
        if (!role) return R.errorResponse(res, 'You cannot assign that role.', 422);
        if (!isSuper) {
            const assignable = !['super-admin', 'company-admin'].includes(role.slug)
                && ((role.is_system && role.license_id == null) || role.license_id === licenseIdForRole);
            if (!assignable) {
                return R.errorResponse(res, 'You cannot assign that role.', 422);
            }
        }

        const password_hash = await hash(body.password);
        const now = new Date();
        const licenseId = (req.user && req.user.license_id) || null;
        const masterDb = require('../../config/masterDb').db;

        // Shared fields for BOTH the master (auth) row and the tenant mirror.
        const base = {
            company_id:  req.companyId,
            license_id:  licenseId,
            role_id:     body.role_id,
            name:        body.name,
            email,
            mobile:      body.mobile ?? null,
            password_hash,
            status:      body.status || 'Active',
            // Location scoping: a location-restricted creator can only place new
            // users in THEIR own location; else keep the chosen/blank location_id.
            location_id: req.locationId != null ? req.locationId : (body.location_id ?? null),
            approval_status: 'approved',
            approved_at:     now,
            approved_by:     req.user ? req.user.sub : null,
        };

        // Users straddle two DBs: MASTER holds the LOGIN identity (+ a denormalised
        // role_slug so auth needn't touch a tenant); the TENANT holds a MIRROR at
        // the SAME id so business FKs (created_by, sales_persons.user_id, …)
        // resolve. Create master first (mints the id), then mirror into the tenant.
        const [mu] = await masterDb('users').insert({ ...base, role_slug: role.slug })
            .returning(['id', 'company_id', 'license_id', 'role_id', 'name', 'email',
                'mobile', 'status', 'approval_status', 'location_id', 'created_at']);

        await db('users').insert({ id: mu.id, ...base });
        await db.raw("SELECT setval(pg_get_serial_sequence('users','id'), (SELECT COALESCE(MAX(id),1) FROM users))");

        // Seats are a MASTER concern (subscriptions + master.users.status). After
        // reconciling, mirror the (possibly flipped) status onto the tenant row so
        // the two stay consistent. A new user over the cap ends up Inactive.
        if (licenseId) {
            await reconcileLicenseSeats(masterDb, licenseId);
            const fresh = await masterDb('users').where('id', mu.id).first('status');
            if (fresh) {
                mu.status = fresh.status;
                await db('users').where('id', mu.id).update({ status: fresh.status });
            }
        }

        const msg = mu.status === 'Active'
            ? 'User created. They can sign in now.'
            : 'User created but inactive — the license seat limit is reached. Raise the plan (max_users) to activate them.';
        return R.successResponse(res, mu, msg);
    } catch (err) {
        console.error('users.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list,
    create,
};
