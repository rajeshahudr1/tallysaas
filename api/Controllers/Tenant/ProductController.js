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
const { fullUrl } = require('../../Helpers/uploads');
const { cutoffFromDays } = require('../../Helpers/inactiveCutoff');
const { MOVEMENT_SUBQUERY, closingStockSql, AVG_PURCHASE_RATE_SQL } = require('../../Helpers/stockMovement');
const customerUsers = require('./CustomerUserController');

/**
 * extraScope — for a customer-portal login (customers.user_id link): restrict
 * to the products of their ASSIGNED categories; a category narrowed via
 * customer_user_products shows only those specific products. Everyone else is
 * unaffected. The loaded catalog is stashed on req for decorate() to price with.
 */
async function productExtraScope(qb, req) {
    if (!req.isCustomerUser) return;
    const catalog = await customerUsers.loadCatalog(req.companyId, req.customerId);
    req._customerCatalog = catalog;
    const catIds = Array.from(catalog.categories.keys());
    if (!catIds.length) { qb.whereRaw('1 = 0'); return; }   // nothing assigned → empty list
    qb.where(function () {
        for (const catId of catIds) {
            const narrowed = catalog.productsByCategory.get(catId);
            this.orWhere(function () {
                this.where('products.category_id', catId);
                if (narrowed && narrowed.size) this.whereIn('products.id', Array.from(narrowed));
            });
        }
    });
}

/** Attach each product's image gallery (absolute URLs) + a primary `image_url`,
 * fetched in one query for the whole page. So the web/app get ready-to-use
 * image URLs from the list AND the detail — no path building client-side. */
async function decorate(rows, req) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const imgs = await db('product_images')
        .whereIn('product_id', ids).whereNull('deleted_at')
        .orderBy('sort_order', 'asc').orderBy('id', 'asc')
        .select('id', 'product_id', 'file_path');
    const byProduct = {};
    for (const im of imgs) {
        (byProduct[im.product_id] = byProduct[im.product_id] || []).push({ id: im.id, url: fullUrl(req, im.file_path) });
    }
    let out = rows.map((r) => {
        const gallery = byProduct[r.id] || [];
        return {
            ...r,
            // An HSN is a numeric code. Some Tally masters carry a literal
            // placeholder ("Not Found", "NA", "-") where the code is missing,
            // and printing that into an invoice's HSN column puts a made-up
            // value on a tax document. Anything non-numeric reads as absent.
            hsn_code: /^\d+$/.test(String(r.hsn_code || '').trim()) ? r.hsn_code : null,
            images: gallery,
            image_url: gallery.length ? gallery[0].url : null,
        };
    });
    // Customer-portal login: replace the price with the LOCKED adjusted rate
    // (sales_price × category discount/addition %) and hide the buy price. The
    // catalog was loaded by productExtraScope on the same request.
    if (req.isCustomerUser && req._customerCatalog) {
        out = out.map((r) => {
            const priced = customerUsers.priceProduct(req._customerCatalog, r);
            return {
                ...r,
                sales_price:    priced.allowed ? priced.rate : r.sales_price,
                rate:           priced.allowed ? priced.rate : r.sales_price,
                purchase_price: null,
            };
        });
    }
    return out;
}

// Columns returned by list/get. `products.*` gives every base column; the
// aliased join adds a human-readable label for the category FK.
/**
 * Per-item stock movement, aggregated ONCE from Tally's inventory mirror and
 * joined by item name.
 *
 * Written as a joined aggregate rather than correlated subqueries: the list
 * needs four figures per row (in/out quantity and in value), and evaluating
 * those per product turned a 5,000-item page into a query that never
 * returned. One grouped pass over the entries costs the same for one row or
 * all of them.
 *
 * Direction comes from the VOUCHER, never from the sign of qty — Tally records
 * an inventory quantity as a positive magnitude on both sides:
 *   in  = Purchase, Receipt Note, Credit Note (a sales return coming BACK IN)
 *   out = Sales, Delivery Note, Debit Note (a purchase return going BACK OUT)
 * `i.type` is also consulted because custom sales classes (RETAIL CASH SALES
 * and the like) do not call themselves "Sales".
 */
// company_id is GROUPED and joined on, rather than filtered by a bind: the
// factory calls baseQuery() without the request, and a tenant db can hold more
// than one company — dropping the company from the key would let one company's
// movement leak into another's closing stock.
// Stock movement + the figures derived from it live in one place, shared with
// the sales-invoice stock guard — see Helpers/stockMovement.js for why.
const CLOSING_STOCK_SQL = closingStockSql('products');

// Columns returned by list/get. `products.*` gives every base column; the
// aliased join adds a human-readable label for the category FK.
const LIST_COLUMNS = [
    'products.*',
    'categories.name as category',
    // Reported per ITEM (not per godown) — the godown split is its own view.
    db.raw(`${CLOSING_STOCK_SQL} as closing_stock`),
    db.raw(`${AVG_PURCHASE_RATE_SQL} as avg_purchase_rate`),
    // What the stock on hand is WORTH — closing quantity at the average rate
    // we actually paid, which is how the Inventory Amount on the dashboard is
    // reckoned. NULL rather than 0 when the item has never been purchased:
    // there is no rate to value it at, and a 0 would read as worthless stock
    // instead of unvalued stock.
    db.raw(`(case when ${AVG_PURCHASE_RATE_SQL} is null then null
                  else ${CLOSING_STOCK_SQL} * ${AVG_PURCHASE_RATE_SQL} end) as stock_value`),
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
        .leftJoin('categories', 'categories.id', 'products.category_id')
        // Tally's inventory movement, aggregated once (see MOVEMENT_SUBQUERY)
        // and matched by item NAME — the mirror carries no product FK.
        .leftJoin(
            database.raw(`(${MOVEMENT_SUBQUERY}) as mv`),
            database.raw('mv.company_id = products.company_id and mv.item_key = lower(products.name)'),
        );
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
        closing_stock:  'closing_stock',
        avg_purchase_rate: 'avg_purchase_rate',
        stock_value:    'stock_value',
    },
    // Filter dropdowns (?key=value) → WHERE.
    filters: {
        category:    (qb, v) => qb.where('categories.name', v),
        // Category-wise listing by id — ?category_id=3 (safer than the name
        // filter for API integrations; ignored when not a positive integer).
        category_id: (qb, v) => {
            const id = Number(v);
            if (Number.isInteger(id) && id > 0) qb.where('products.category_id', id);
        },
        gst_rate: (qb, v) => qb.where('products.gst_rate', v),
        hsn:      (qb, v) => qb.where('products.hsn_code', 'ilike', `%${v}%`),
        // ?stock=in|out|negative — the stock-position tabs. "out" means exactly
        // zero; a NEGATIVE closing stock is its own case (Tally allows it, and
        // it usually means a sale was booked before its purchase), so it gets
        // its own filter rather than being lumped in with "not in stock".
        stock: (qb, v) => {
            if (v === 'in')       return qb.whereRaw(`${CLOSING_STOCK_SQL} > 0`);
            if (v === 'out')      return qb.whereRaw(`${CLOSING_STOCK_SQL} = 0`);
            if (v === 'negative') return qb.whereRaw(`${CLOSING_STOCK_SQL} < 0`);
            return qb;
        },
        // ?inactive=90 — products not sold in the last N days. Drives the
        // dashboard's "Inactive Stocks" tile.
        inactive: (qb, v) => {
            const cutoff = cutoffFromDays(v);
            if (!cutoff) return qb;
            return qb.whereNotExists(function () {
                this.select(db.raw('1')).from('invoice_items')
                    .join('invoices', 'invoices.id', 'invoice_items.invoice_id')
                    .whereRaw('invoice_items.product_id = products.id')
                    .whereNull('invoices.deleted_at')
                    .where('invoices.type', 'sales')
                    .where('invoices.invoice_date', '>=', cutoff);
            });
        },
    },
    baseQuery,
    buildInsert,
    buildUpdate,
    decorate,
    extraScope: productExtraScope,
    hasCreatedBy: true,
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
