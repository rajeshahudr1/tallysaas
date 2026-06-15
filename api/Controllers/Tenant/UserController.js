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
        // unique across the whole install (global), which also covers the
        // company-scoped case. Ignore soft-deleted rows so a previously removed
        // email can be reused.
        const existing = await db('users')
            .whereNull('deleted_at')
            .where('email', email)
            .first();
        if (existing) {
            return R.errorResponse(res, DUP_EMAIL_MSG, 422);
        }

        const password_hash = await hash(body.password);

        // Coerce optional fields away from `undefined` — knex throws "Undefined
        // binding(s)" on an undefined insert value (it does NOT substitute the
        // column DEFAULT). status defaults to 'Active' (a NOT NULL column).
        const row = {
            company_id:    req.companyId,
            license_id:    (req.user && req.user.license_id) || null,
            role_id:       body.role_id,
            name:          body.name,
            email,
            mobile:        body.mobile ?? null,
            password_hash,
            status:        body.status || 'Active',
            location_id:   body.location_id ?? null,
        };

        // Return only safe columns (never the hash / session secrets).
        const [inserted] = await db('users').insert(row).returning([
            'id', 'company_id', 'license_id', 'role_id',
            'name', 'email', 'mobile', 'status', 'location_id', 'created_at',
        ]);

        return R.successResponse(res, inserted, 'User created.');
    } catch (err) {
        console.error('users.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list,
    create,
};
