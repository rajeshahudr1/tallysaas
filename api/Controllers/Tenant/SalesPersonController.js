'use strict';

/**
 * api/Controllers/Tenant/SalesPersonController.js
 *
 * Tenant CRUD for the sales_persons resource, wired entirely through the
 * crudController factory — company scoping, soft-delete, pagination, search and
 * the response envelope all live in Helpers/crudController. There is no bespoke
 * query logic here.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'sales_persons'
 *   • searchCols  — name / employee_code / mobile / email (ILIKE'd on ?search,
 *                   qualified with the table name to stay unambiguous).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * No joins / list labels for this resource (sales_persons.* only).
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;
const R    = require('../../Helpers/response');
const { hash } = require('../../Helpers/passwords');
const { reconcileLicenseSeats } = require('../../Helpers/seats');
const { emailInUse, EMAIL_TAKEN_MSG } = require('../../Helpers/emailUnique');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Sales Person not found.';
const DUP_EMAIL_MSG = 'A user with this email already exists.';

// Columns returned by list/get. `sales_persons.*` gives every base column; no
// join labels are needed for this resource.
const LIST_COLUMNS = [
    'sales_persons.*',
];

// Free-text search targets (qualified by table name for unambiguous ILIKE).
const SEARCH_COLS = [
    'sales_persons.name',
    'sales_persons.employee_code',
    'sales_persons.mobile',
    'sales_persons.email',
];

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied the default for status, so it is present here; the
 * remaining optionals fall back to undefined and Knex omits them (the table
 * defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:          body.name,
        employee_code: body.employee_code,
        mobile:        body.mobile,
        email:         body.email,
        joining_date:  body.joining_date,
        user_id:       body.user_id,
        status:        body.status,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'employee_code', 'mobile', 'email',
    'joining_date', 'user_id', 'status',
];

/**
 * Map the validated UPDATE body to a patch containing ONLY the keys the client
 * actually sent (the update schema applies no defaults). This keeps a partial
 * PUT partial — absent fields are not overwritten with undefined/null.
 */
function buildUpdate(body) {
    const patch = {};
    for (const key of UPDATABLE) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            patch[key] = body[key];
        }
    }
    return patch;
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'sales_persons',
    notFound:    'Sales Person not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['sales_persons.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at sort by default).
    sortable: {
        employee_code: 'sales_persons.employee_code',
        mobile:        'sales_persons.mobile',
        email:         'sales_persons.email',
    },
    // Email is the global login identity — unique across BOTH sales_persons AND
    // users. On update (currentId = this sales person id) exclude this row and
    // its OWN linked login user (the same person shares the email). On create
    // currentId is undefined. Email is optional on a sales person, so skip when blank.
    uniqueCheck: async (database, body, _companyId, currentId) => {
        if (!body.email) return null;
        let exceptUserId = null;
        if (currentId) {
            const sp = await database('sales_persons').where('id', currentId).first('user_id');
            exceptUserId = sp ? sp.user_id : null;
        }
        const taken = await emailInUse(database, body.email, {
            exceptSalesPersonId: currentId || null,
            exceptUserId,
        });
        return taken ? { msg: EMAIL_TAKEN_MSG, status: 422 } : null;
    },
    buildInsert,
    buildUpdate,
});

// ───────────────────────────────────────────────────────────────────
// Bespoke endpoints layered on top of the CRUD factory:
//   POST /sales-persons/:id/login      — create/link the login user (atomic)
//   PUT  /sales-persons/:id/locations  — replace assigned locations
//   PUT  /sales-persons/:id/customers  — replace assigned customers (per location)
//   GET  /sales-persons/:id/assignments — prefill payload for the edit form
//
// All four are company-scoped (req.companyId) and soft-delete aware. They use
// the SAME guard chain as the CRUD routes (authenticate, resolveCompany,
// resolveLocation, can('sales-persons', …)).
// ───────────────────────────────────────────────────────────────────

// Load the company-scoped, non-deleted sales person row or null.
async function fetchSalesPerson(companyId, id, trx) {
    const q = (trx || db)('sales_persons')
        .where('company_id', companyId)
        .where('id', id)
        .whereNull('deleted_at');
    return q.first();
}

/**
 * POST /api/v1/sales-persons/:id/login
 *
 * Make this sales person a LOGIN USER (same identity). Body validated by
 * loginSchema { email, password?, role_id, status? }.
 *
 *   • If sales_persons.user_id is NULL → CREATE a users row (reusing the
 *     UserController.create rules: dup-email guard, role-assignability, password
 *     hash, seat reconcile) in a transaction, then set sales_persons.user_id.
 *     location_id is forced NULL so the single-location scope does NOT restrict
 *     the sales person (they reach multiple branches via the join tables).
 *   • If sales_persons.user_id is SET → UPDATE that user: role_id, optional
 *     status, and an optional password reset (only when a password is supplied).
 *
 * Atomic: either the whole link succeeds or nothing is written (no half state).
 * Returns the linked user summary.
 */
async function setLogin(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const sp = await fetchSalesPerson(req.companyId, id);
        if (!sp) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const { email, password, role_id } = req.body;
        const status = req.body.status; // optional

        // Role-assignability (same policy as UserController.create): a tenant may
        // assign a global SYSTEM role EXCEPT the platform/admin roles, or one of
        // THEIR OWN license's custom roles — nothing else. Super Admin bypasses.
        const isSuper = req.user && req.user.role_slug === 'super-admin';
        if (!isSuper) {
            const licenseId = (req.user && req.user.license_id) || null;
            const role = await db('roles').where('id', role_id)
                .first('id', 'slug', 'is_system', 'license_id');
            const assignable = role
                && !['super-admin', 'company-admin'].includes(role.slug)
                && ((role.is_system && role.license_id == null) || role.license_id === licenseId);
            if (!assignable) {
                return R.errorResponse(res, 'You cannot assign that role.', 422);
            }
        }

        const licenseId = (req.user && req.user.license_id) || null;

        // ── UPDATE path: the sales person already has a linked login user. ──
        if (sp.user_id) {
            const linked = await db('users')
                .where('id', sp.user_id)
                .whereNull('deleted_at')
                .first('id', 'email', 'role_id', 'status');
            if (!linked) {
                // The link is dangling (the user was hard-deleted). Treat it as a
                // create so the sales person can get a fresh login — fall through.
                sp.user_id = null;
            } else {
                // If the email is changing, guard against a duplicate across BOTH
                // tables — excluding this login user and this sales person (same person).
                if (email && email !== linked.email) {
                    const clash = await emailInUse(db, email, {
                        exceptUserId: linked.id,
                        exceptSalesPersonId: sp.id,
                    });
                    if (clash) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
                }

                const patch = { role_id, updated_at: new Date() };
                if (email) patch.email = email;
                if (status) patch.status = status;
                if (password) patch.password_hash = await hash(password);

                const [updated] = await db('users').where('id', linked.id).update(patch)
                    .returning(['id', 'email', 'role_id', 'status']);

                return R.successResponse(res, {
                    id:      updated.id,
                    email:   updated.email,
                    role_id: updated.role_id,
                    status:  updated.status,
                }, 'Login updated.');
            }
        }

        // ── CREATE path: no linked user yet (or the link was dangling). ──
        if (!password) {
            return R.errorResponse(res, 'Password is required to create a login.', 422);
        }

        // Duplicate-email guard across BOTH users + sales_persons — excluding
        // THIS sales person's own row (its email legitimately becomes the login).
        const taken = await emailInUse(db, email, { exceptSalesPersonId: sp.id });
        if (taken) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);

        const password_hash = await hash(password);
        const now = new Date();
        const row = {
            company_id:      req.companyId,
            license_id:      licenseId,
            role_id,
            name:            sp.name,
            email,
            mobile:          sp.mobile || null,
            password_hash,
            status:          status || 'Active',
            // NULL so the single-location scope does not restrict the sales person
            // — multi-location reach comes from sales_person_locations, not here.
            location_id:     null,
            approval_status: 'approved',
            approved_at:     now,
            approved_by:     req.user ? req.user.sub : null,
        };

        // Create the user, reconcile seats, and link it to the sales person — all
        // in ONE transaction so a failure leaves no half state.
        const linked = await db.transaction(async (trx) => {
            const [u] = await trx('users').insert(row).returning([
                'id', 'email', 'role_id', 'status',
            ]);
            if (licenseId) {
                await reconcileLicenseSeats(trx, licenseId);
                const fresh = await trx('users').where('id', u.id).first('status');
                if (fresh) u.status = fresh.status;
            }
            await trx('sales_persons').where('id', sp.id)
                .update({ user_id: u.id, updated_at: new Date() });
            return u;
        });

        const msg = linked.status === 'Active'
            ? 'Login created. The sales person can sign in now.'
            : 'Login created but inactive — the license seat limit is reached. Raise the plan (max_users) to activate them.';
        return R.successResponse(res, {
            id:      linked.id,
            email:   linked.email,
            role_id: linked.role_id,
            status:  linked.status,
        }, msg);
    } catch (err) {
        console.error('sales_persons.setLogin error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * PUT /api/v1/sales-persons/:id/locations
 *
 * Replace the sales person's assigned locations. Body validated by
 * assignLocationsSchema { location_ids: [] }. The given ids are filtered to
 * those that belong to the caller's company (a foreign id is silently dropped,
 * never assigned). Done in a transaction: delete-all then insert.
 */
async function setLocations(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const sp = await fetchSalesPerson(req.companyId, id);
        if (!sp) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const requested = Array.from(new Set(req.body.location_ids || []));

        // Keep only locations that actually belong to this company (non-deleted).
        let validIds = [];
        if (requested.length) {
            const rows = await db('locations')
                .where('company_id', req.companyId)
                .whereNull('deleted_at')
                .whereIn('id', requested)
                .select('id');
            validIds = rows.map((r) => Number(r.id));
        }

        await db.transaction(async (trx) => {
            await trx('sales_person_locations')
                .where('company_id', req.companyId)
                .where('sales_person_id', sp.id)
                .del();
            if (validIds.length) {
                const now = new Date();
                await trx('sales_person_locations').insert(validIds.map((locId) => ({
                    company_id:      req.companyId,
                    sales_person_id: sp.id,
                    location_id:     locId,
                    created_at:      now,
                    updated_at:      now,
                })));
            }
        });

        return R.successResponse(res, { location_ids: validIds }, 'Locations updated.');
    } catch (err) {
        console.error('sales_persons.setLocations error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * PUT /api/v1/sales-persons/:id/customers
 *
 * Replace the sales person's assigned customers FOR ONE location. Body validated
 * by assignCustomersSchema { location_id, customer_ids: [] }. The location must
 * be one of the sales person's ASSIGNED locations; the customer ids are filtered
 * to those that belong to that company + location (foreign ids are dropped).
 * Only the rows for (this sales person + this location) are replaced — other
 * locations' assignments are untouched.
 */
async function setCustomers(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const sp = await fetchSalesPerson(req.companyId, id);
        if (!sp) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const locationId = Number(req.body.location_id);

        // The location must be one this sales person is actually assigned to.
        const assigned = await db('sales_person_locations')
            .where('company_id', req.companyId)
            .where('sales_person_id', sp.id)
            .where('location_id', locationId)
            .first('id');
        if (!assigned) {
            return R.errorResponse(res, 'That location is not assigned to this sales person.', 422);
        }

        const requested = Array.from(new Set(req.body.customer_ids || []));

        // Keep only customers that belong to this company AND this location.
        let validIds = [];
        if (requested.length) {
            const rows = await db('customers')
                .where('company_id', req.companyId)
                .where('location_id', locationId)
                .whereNull('deleted_at')
                .whereIn('id', requested)
                .select('id');
            validIds = rows.map((r) => Number(r.id));
        }

        await db.transaction(async (trx) => {
            await trx('sales_person_customers')
                .where('company_id', req.companyId)
                .where('sales_person_id', sp.id)
                .where('location_id', locationId)
                .del();
            if (validIds.length) {
                const now = new Date();
                await trx('sales_person_customers').insert(validIds.map((custId) => ({
                    company_id:      req.companyId,
                    sales_person_id: sp.id,
                    customer_id:     custId,
                    location_id:     locationId,
                    created_at:      now,
                    updated_at:      now,
                })));
            }
        });

        return R.successResponse(res, { location_id: locationId, customer_ids: validIds },
            'Customer assignments updated.');
    } catch (err) {
        console.error('sales_persons.setCustomers error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /api/v1/sales-persons/:id/assignments
 *
 * Prefill payload for the edit form:
 *   { location_ids: [...],
 *     customers:   { "<location_id>": [customer_id, ...], ... },
 *     user:        { id, email, role_id, status } | null }
 */
async function getAssignments(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const sp = await fetchSalesPerson(req.companyId, id);
        if (!sp) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const locRows = await db('sales_person_locations')
            .where('company_id', req.companyId)
            .where('sales_person_id', sp.id)
            .select('location_id');
        const locationIds = locRows.map((r) => Number(r.location_id));

        const custRows = await db('sales_person_customers')
            .where('company_id', req.companyId)
            .where('sales_person_id', sp.id)
            .select('location_id', 'customer_id');
        const customers = {};
        for (const r of custRows) {
            const key = String(r.location_id);
            if (!customers[key]) customers[key] = [];
            customers[key].push(Number(r.customer_id));
        }

        let user = null;
        if (sp.user_id) {
            user = await db('users')
                .where('id', sp.user_id)
                .whereNull('deleted_at')
                .first('id', 'email', 'role_id', 'status');
            if (user) {
                user = {
                    id: user.id, email: user.email, role_id: user.role_id, status: user.status,
                };
            }
        }

        return R.successResponse(res, { location_ids: locationIds, customers, user });
    } catch (err) {
        console.error('sales_persons.getAssignments error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
    setLogin,
    setLocations,
    setCustomers,
    getAssignments,
};
