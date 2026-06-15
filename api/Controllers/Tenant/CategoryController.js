'use strict';

/**
 * api/Controllers/Tenant/CategoryController.js
 *
 * Tenant CRUD for product categories (Tally stock groups), wired entirely
 * through the crudController factory — same pattern as CustomerController.
 * There is intentionally NO bespoke query logic here: company scoping,
 * soft-delete, pagination, search and the response envelope all live in
 * Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'categories'
 *   • baseQuery   — a self LEFT JOIN to `categories as parent` so list/get rows
 *                   carry a friendly `parent` name label (NULL when top-level).
 *   • searchCols  — name (ILIKE'd on ?search, qualified for the join).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;

// Columns returned by list/get. `categories.*` gives every base column; the
// aliased self-join adds a human-readable label for the parent FK.
const LIST_COLUMNS = [
    'categories.*',
    'parent.name as parent',
];

// Free-text search targets (qualified — the base query has a self join, so a
// bare column name would be ambiguous).
const SEARCH_COLS = [
    'categories.name',
];

/**
 * Base query with the self parent-label join. The factory layers
 * `where categories.company_id = ?` and `whereNull(categories.deleted_at)` on
 * top, so the tenant + soft-delete columns are referenced by their qualified
 * names.
 */
function baseQuery(database) {
    return database('categories')
        .leftJoin('categories as parent', 'parent.id', 'categories.parent_id');
}

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied the default for status, so it is present here;
 * `parent_id` falls back to undefined when omitted and Knex omits it (the table
 * NULL default applies → a top-level category).
 */
function buildInsert(body) {
    return {
        name:      body.name,
        parent_id: body.parent_id,
        status:    body.status,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'parent_id', 'status',
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
    table:       'categories',
    notFound:    'Category not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['categories.id', 'desc']],
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
