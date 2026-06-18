'use strict';

/**
 * api/Controllers/Tenant/SupplierController.js
 *
 * Tenant CRUD for suppliers (Tally "sundry creditors"), wired entirely through
 * the crudController factory — the same pattern CustomerController established.
 * There is intentionally NO bespoke query logic here: company scoping,
 * soft-delete, pagination, search and the response envelope all live in
 * Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'suppliers'
 *   • baseQuery   — LEFT JOIN to locations so list/get rows carry a friendly
 *                   `location` name label (NULL when unassigned).
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

// Columns returned by list/get. `suppliers.*` gives every base column; the
// aliased join adds a human-readable label for the location FK target.
const LIST_COLUMNS = [
    'suppliers.*',
    'locations.name as location',
];

// Free-text search targets (qualified — the base query has a join, so bare
// column names would be ambiguous).
const SEARCH_COLS = [
    'suppliers.name',
    'suppliers.mobile',
    'suppliers.email',
    'suppliers.gst_number',
];

/**
 * Base query with the location label join. The factory layers
 * `where suppliers.company_id = ?` and `whereNull(suppliers.deleted_at)` on top,
 * so the tenant + soft-delete columns are referenced by their qualified names.
 */
function baseQuery(database) {
    return database('suppliers')
        .leftJoin('locations', 'locations.id', 'suppliers.location_id');
}

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied defaults for opening_balance / status /
 * is_tally_ledger, so they are present here; the remaining optionals fall back
 * to undefined and Knex omits them (the table defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:             body.name,
        mobile:           body.mobile,
        alternate_mobile: body.alternate_mobile,
        email:            body.email,
        gst_number:       body.gst_number,
        pan_number:       body.pan_number,
        supplier_group:   body.supplier_group,
        location_id:      body.location_id,
        opening_balance:  body.opening_balance,
        payment_terms:    body.payment_terms,
        status:           body.status,
        is_tally_ledger:  body.is_tally_ledger,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'mobile', 'alternate_mobile', 'email', 'gst_number', 'pan_number',
    'supplier_group', 'location_id', 'opening_balance', 'payment_terms',
    'status', 'is_tally_ledger',
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
    patch.tally_dirty = true;   // cloud edit → re-push to Tally (ALTER)
    return patch;
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'suppliers',
    notFound:    'Supplier not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['suppliers.id', 'desc']],
    searchCols:  SEARCH_COLS,
    baseQuery,
    buildInsert,
    buildUpdate,
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
