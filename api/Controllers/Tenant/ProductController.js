'use strict';

/**
 * api/Controllers/Tenant/ProductController.js
 *
 * Tenant-scoped CRUD for products (Tally stock items), wired entirely through
 * the crudController factory — mirroring CustomerController. There is
 * intentionally NO bespoke query logic here: company scoping, soft-delete,
 * pagination, search and the response envelope all live in
 * Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'products'
 *   • baseQuery   — LEFT JOIN to categories so list/get rows carry a friendly
 *                   `category` name label (NULL when unassigned).
 *   • searchCols  — name / sku / hsn_code (ILIKE'd on ?search, table-qualified
 *                   because the base query has a join).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;

// Columns returned by list/get. `products.*` gives every base column; the
// aliased join adds a human-readable label for the category FK.
const LIST_COLUMNS = [
    'products.*',
    'categories.name as category',
];

// Free-text search targets (qualified — the base query has a join, so bare
// column names would be ambiguous).
const SEARCH_COLS = [
    'products.name',
    'products.sku',
    'products.hsn_code',
    'categories.name',
];

/**
 * Base query with the category label join. The factory layers
 * `where products.company_id = ?` and `whereNull(products.deleted_at)` on top,
 * so the tenant + soft-delete columns are referenced by their qualified names.
 */
function baseQuery(database) {
    return database('products')
        .leftJoin('categories', 'categories.id', 'products.category_id');
}

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied defaults for gst_rate / purchase_price / sales_price /
 * opening_stock / status / is_tally_item, so they are present here; the
 * remaining optionals fall back to undefined and Knex omits them (the table
 * defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:           body.name,
        sku:            body.sku,
        unit:           body.unit,
        hsn_code:       body.hsn_code,
        gst_rate:       body.gst_rate,
        purchase_price: body.purchase_price,
        sales_price:    body.sales_price,
        opening_stock:  body.opening_stock,
        category_id:    body.category_id,
        status:         body.status,
        is_tally_item:  body.is_tally_item,
        description:    body.description,
        custom_fields:  (body.custom_fields && typeof body.custom_fields === 'object')
            ? JSON.stringify(body.custom_fields) : undefined,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'sku', 'unit', 'hsn_code', 'gst_rate',
    'purchase_price', 'sales_price', 'opening_stock',
    'category_id', 'status', 'is_tally_item', 'description', 'custom_fields',
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
    if (patch.custom_fields && typeof patch.custom_fields === 'object') {
        patch.custom_fields = JSON.stringify(patch.custom_fields);
    }
    patch.tally_dirty = true;   // cloud edit → re-push to Tally (ALTER)
    return patch;
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'products',
    notFound:    'Product not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['products.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at sort by default).
    sortable: {
        sku:            'products.sku',
        category:       'categories.name',
        hsn:            'products.hsn_code',
        gst_rate:       'products.gst_rate',
        purchase_price: 'products.purchase_price',
        sales_price:    'products.sales_price',
        stock:          'products.opening_stock',
    },
    // Filter dropdowns (?key=value) → WHERE.
    filters: {
        category: (qb, v) => qb.where('categories.name', v),
        gst_rate: (qb, v) => qb.where('products.gst_rate', v),
        hsn:      (qb, v) => qb.where('products.hsn_code', 'ilike', `%${v}%`),
    },
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
