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
