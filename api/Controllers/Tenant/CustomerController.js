'use strict';

/**
 * api/Controllers/Tenant/CustomerController.js
 *
 * The sample tenant CRUD, wired entirely through the crudController factory —
 * it proves the factory pattern every later resource (products, suppliers,
 * invoices, …) will reuse. There is intentionally NO bespoke query logic here:
 * company scoping, soft-delete, pagination, search and the response envelope all
 * live in Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'customers'
 *   • baseQuery   — LEFT JOINs to locations / sales_persons / customer_groups so
 *                   list/get rows carry friendly `location`, `sales_person`,
 *                   `customer_group` name labels (NULL when unassigned).
 *   • searchCols  — name / mobile / email / gst_number (ILIKE'd on ?search).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;
const { cutoffFromDays } = require('../../Helpers/inactiveCutoff');

// Columns returned by list/get. `customers.*` gives every base column; the three
// aliased joins add human-readable labels for the FK targets.
const LIST_COLUMNS = [
    'customers.*',
    'locations.name as location',
    'sales_persons.name as sales_person',
    'customer_groups.name as customer_group',
];

// Free-text search targets (qualified — the base query has joins, so bare column
// names would be ambiguous).
const SEARCH_COLS = [
    'customers.name',
    'customers.mobile',
    'customers.email',
    'customers.gst_number',
    'customers.pan_number',
    'customers.billing_address',
    'locations.name',
];

/**
 * Base query with the three label joins. The factory layers
 * `where customers.company_id = ?` and `whereNull(customers.deleted_at)` on top,
 * so the tenant + soft-delete columns are referenced by their qualified names.
 */
function baseQuery(database) {
    return database('customers')
        .leftJoin('locations',       'locations.id',       'customers.location_id')
        .leftJoin('sales_persons',   'sales_persons.id',   'customers.sales_person_id')
        .leftJoin('customer_groups', 'customer_groups.id', 'customers.customer_group_id');
}

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied defaults for opening_balance / credit_limit / status /
 * is_tally_ledger, so they are present here; the remaining optionals fall back
 * to undefined and Knex omits them (the table defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:              body.name,
        mobile:            body.mobile,
        alternate_mobile:  body.alternate_mobile,
        email:             body.email,
        gst_number:        body.gst_number,
        pan_number:        body.pan_number,
        location_id:       body.location_id,
        sales_person_id:   body.sales_person_id,
        customer_group_id: body.customer_group_id,
        opening_balance:   body.opening_balance,
        credit_limit:      body.credit_limit,
        status:            body.status,
        billing_address:   body.billing_address,
        shipping_address:  body.shipping_address,
        is_tally_ledger:   body.is_tally_ledger,
        ledger_group:            body.ledger_group,
        opening_balance_type:    body.opening_balance_type,
        country:                 body.country,
        state:                   body.state,
        city:                    body.city,
        pincode:                 body.pincode,
        gst_registration_type:   body.gst_registration_type,
        notes:             body.notes,
        internal_remarks:  body.internal_remarks,
        custom_fields:     (body.custom_fields && typeof body.custom_fields === 'object')
            ? JSON.stringify(body.custom_fields) : undefined,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'mobile', 'alternate_mobile', 'email', 'gst_number', 'pan_number',
    'location_id', 'sales_person_id', 'customer_group_id',
    'opening_balance', 'credit_limit', 'status',
    'billing_address', 'shipping_address', 'is_tally_ledger',
    'ledger_group', 'opening_balance_type', 'country', 'state', 'city', 'pincode', 'gst_registration_type',
    'notes', 'internal_remarks', 'custom_fields',
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
    // JSONB column wants a string, not a JS object.
    if (patch.custom_fields && typeof patch.custom_fields === 'object') {
        patch.custom_fields = JSON.stringify(patch.custom_fields);
    }
    patch.tally_dirty = true;   // cloud edit → re-push to Tally (ALTER)
    return patch;
}

/**
 * Return the sales_persons.id linked to the requesting login user (req.user.sub)
 * within this company, or null when the caller is NOT a sales-person-user. A
 * single indexed lookup; super-admin (no sub) and ordinary users fall through to
 * null (unaffected). Soft-deleted sales_persons rows are ignored.
 */
async function salesPersonForUser(req) {
    const userId = req.user && req.user.sub;
    if (!userId || req.companyId == null) return null;
    const row = await db('sales_persons')
        .where('company_id', req.companyId)
        .where('user_id', userId)
        .whereNull('deleted_at')
        .first('id');
    return row ? row.id : null;
}

/**
 * extraScope — ADDS a restriction (never widens) for a sales-person-user:
 * they see ONLY the customers assigned to them in sales_person_customers (any
 * location). Super-admin / company-admin / non-sales-person users are
 * UNAFFECTED (salesPersonForUser returns null → no extra filter). Company +
 * location scoping already applied by the factory stays intact.
 */
async function customerExtraScope(qb, req) {
    // Customer-portal login: they see ONLY their own customer row (needed by the
    // invoice form's party dropdown; the API forces their id on create anyway).
    if (req.isCustomerUser) {
        qb.where('customers.id', req.customerId);
        return;
    }
    // Website users (third-party API parties) live on the Website Users screen,
    // not in the customer master list.
    qb.where('customers.is_website_user', false);
    const salesPersonId = await salesPersonForUser(req);
    if (salesPersonId == null) return; // not a sales-person-user → unrestricted
    qb.whereIn('customers.id', (sub) => {
        sub.select('customer_id')
            .from('sales_person_customers')
            .where('company_id', req.companyId)
            .where('sales_person_id', salesPersonId);
    });
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'customers',
    notFound:    'Customer not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['customers.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at sort by default).
    sortable: {
        location:        'locations.name',
        mobile:          'customers.mobile',
        gst:             'customers.gst_number',
        opening_balance: 'customers.opening_balance',
        credit_limit:    'customers.credit_limit',
        sales_person:    'sales_persons.name',
    },
    // Filter dropdowns (?key=value) → WHERE. Names match the joined label cols.
    filters: {
        location:       (qb, v) => qb.where('locations.name', v),
        sales_person:   (qb, v) => qb.where('sales_persons.name', v),
        customer_group: (qb, v) => qb.where('customer_groups.name', v),
        gst:            (qb, v) => qb.where('customers.gst_number', 'ilike', `%${v}%`),
        // ?inactive=90 — customers with NO sales invoice in the last N days.
        // Drives the dashboard's "Inactive Customers" tile.
        inactive: (qb, v) => {
            const cutoff = cutoffFromDays(v);
            if (!cutoff) return qb;
            return qb.whereNotExists(function () {
                this.select(db.raw('1')).from('invoices')
                    .whereRaw('invoices.customer_id = customers.id')
                    .whereNull('invoices.deleted_at')
                    .where('invoices.type', 'sales')
                    .where('invoices.invoice_date', '>=', cutoff);
            });
        },
        // ?missing=mobile|email|contact — customers lacking contact details.
        // 'contact' means EITHER is missing (the dashboard tile's meaning).
        missing: (qb, v) => {
            const blank = (col) => `coalesce(trim(customers.${col}), '') = ''`;
            if (v === 'mobile')  return qb.whereRaw(blank('mobile'));
            if (v === 'email')   return qb.whereRaw(blank('email'));
            if (v === 'contact') return qb.whereRaw(`(${blank('mobile')} OR ${blank('email')})`);
            return qb;
        },
    },
    baseQuery,
    buildInsert,
    buildUpdate,
    extraScope:  customerExtraScope,
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
