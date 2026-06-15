'use strict';

/**
 * api/Controllers/Tenant/CustomerGroupController.js
 *
 * Tenant CRUD for customer_groups, wired entirely through the crudController
 * factory — the same pattern CustomerController uses. There is intentionally NO
 * bespoke query logic here: company scoping, soft-delete, pagination, search and
 * the response envelope all live in Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'customer_groups'
 *   • searchCols  — name (ILIKE'd on ?search; qualified for safety).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * No joins/labels are needed — the table is just company_id + name + timestamps +
 * soft-delete — so there is no baseQuery; the factory's default `db(table)` is
 * used. `customer_groups.*` returns every base column.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');

// Columns returned by list/get. `customer_groups.*` gives every base column;
// there are no FK joins to alias.
const LIST_COLUMNS = [
    'customer_groups.*',
];

// Free-text search targets (qualified for consistency with the shared pattern).
const SEARCH_COLS = [
    'customer_groups.name',
];

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 */
function buildInsert(body) {
    return {
        name: body.name,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name',
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
    table:       'customer_groups',
    notFound:    'Customer Group not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['customer_groups.id', 'desc']],
    searchCols:  SEARCH_COLS,
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
