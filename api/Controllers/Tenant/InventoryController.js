'use strict';

/**
 * api/Controllers/Tenant/InventoryController.js
 *
 * The read-only inventory view — backs GET /inventory. A bespoke (NOT
 * crudController-wired) controller that projects the `products` table into a
 * stock-oriented row shape with a derived status_label, plus a header `stats`
 * block of stock aggregates. It writes nothing.
 *
 * purchased / sold are placeholder 0s for now (no movement ledger yet), so
 * `current` equals `opening_stock`; the shape is forward-compatible with a real
 * movements join later without changing the response contract.
 *
 * Every query is scoped by req.companyId (set by resolveCompany) and filtered
 * with whereNull('deleted_at'). Supports ?search (name / sku), ?status, and
 * ?page / ?per_page pagination (default 10, capped 100).
 *
 * Exports a single handler { list }. Response shape:
 *
 *   {
 *     stats: { stock_value, total_skus, low_stock, out_of_stock },
 *     data:  [ { id, product, sku, category, unit, hsn, opening, purchased,
 *                sold, current, value, status_label } ],
 *     meta:  { total, page, per_page }
 *   }
 *
 * status_label: current<=0 → 'Out of Stock'; current<50 → 'Low Stock';
 *               else 'In Stock'.
 *
 * Conventions: 'use strict', 4-space indent, async handler + try/catch →
 * console.error + errorResponse(res, OOPS_MSG, 500). Uses the shared response
 * envelope (successResponse) and the single shared Knex instance.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE     = 100;

// Low-stock threshold — at/under this (but > 0) a SKU is flagged 'Low Stock'.
const LOW_STOCK_LIMIT = 50;

// Coerce a pg numeric (string | null | number) into a real JS number, 0 on null.
function num(x) {
    return Number(x || 0);
}

// Clamp/normalise pagination from the request query.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

// Derive the human stock status from the current quantity on hand.
function statusLabel(current) {
    if (current <= 0)              return 'Out of Stock';
    if (current < LOW_STOCK_LIMIT) return 'Low Stock';
    return 'In Stock';
}

/**
 * Base, company-scoped, not-deleted products query with the category label
 * join. The list handler layers search / status / pagination on top, so the
 * tenant + deleted_at columns are referenced by their qualified names.
 */
function baseQuery(companyId) {
    return db('products')
        .leftJoin('categories', 'categories.id', 'products.category_id')
        .where('products.company_id', companyId)
        .whereNull('products.deleted_at');
}

/**
 * GET /inventory — paginated stock rows + header stats. The stats aggregate the
 * WHOLE filtered set (not just the current page); the rows are the page slice.
 */
async function list(req, res) {
    try {
        const companyId         = req.companyId;
        const { page, perPage } = parsePagination(req.query);
        const search            = (req.query.search || '').trim();
        const status            = (req.query.status || '').trim();

        const category = (req.query.category || '').trim();
        // Apply the optional filters identically to every derived query so the
        // count / stats / rows all describe the same filtered population.
        const applyFilters = (qb) => {
            if (status) {                              // derived stock-status filter
                if (/out/i.test(status))       qb = qb.where('products.opening_stock', '<=', 0);
                else if (/low/i.test(status))  qb = qb.whereRaw('products.opening_stock > 0 AND products.opening_stock < ?', [LOW_STOCK_LIMIT]);
                else if (/in\s*stock/i.test(status)) qb = qb.where('products.opening_stock', '>=', LOW_STOCK_LIMIT);
                else qb = qb.where('products.status', status);
            }
            if (category) qb = qb.where('categories.name', category);
            if (search) {                              // search across all columns
                const like = `%${search}%`;
                qb = qb.where((b) => {
                    b.where('products.name', 'ilike', like)
                     .orWhere('products.sku', 'ilike', like)
                     .orWhere('products.hsn_code', 'ilike', like)
                     .orWhere('products.unit', 'ilike', like)
                     .orWhere('categories.name', 'ilike', like);
                });
            }
            return qb;
        };
        // Header-sort: map a UI sort key → a real column (default newest first).
        const SORT_MAP = {
            product: 'products.name', sku: 'products.sku', category: 'categories.name',
            current: 'products.opening_stock', value: 'products.opening_stock', status: 'products.status',
        };
        const sortCol = SORT_MAP[(req.query.sort || '').trim()] || 'products.id';
        const sortDir = (req.query.order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';

        // Total (filtered) count — BEFORE pagination.
        const totalRow = await applyFilters(baseQuery(companyId))
            .count('products.id as c').first();
        const total = num(totalRow && totalRow.c);

        // stats — aggregate the whole filtered set. current == opening_stock
        // while there is no movement ledger, so the low/out buckets key off
        // opening_stock directly.
        const statsRow = await applyFilters(baseQuery(companyId))
            .select(
                db.raw('COALESCE(SUM(products.sales_price * products.opening_stock), 0) as stock_value'),
                db.raw('COUNT(products.id) as total_skus'),
                db.raw(`COUNT(*) FILTER (WHERE products.opening_stock > 0 AND products.opening_stock < ?) as low_stock`, [LOW_STOCK_LIMIT]),
                db.raw('COUNT(*) FILTER (WHERE products.opening_stock <= 0) as out_of_stock'),
            )
            .first();

        const stats = {
            stock_value:  num(statsRow && statsRow.stock_value),
            total_skus:   num(statsRow && statsRow.total_skus),
            low_stock:    num(statsRow && statsRow.low_stock),
            out_of_stock: num(statsRow && statsRow.out_of_stock),
        };

        // Page slice of product rows + category label.
        const productRows = await applyFilters(baseQuery(companyId))
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy(sortCol, sortDir)
            .select(
                'products.id',
                'products.name as product',
                'products.sku',
                'categories.name as category',
                'products.unit',
                'products.hsn_code as hsn',
                'products.opening_stock as opening',
                'products.sales_price', 'products.purchase_price',
            );

        // REAL stock movement for THIS page from Tally's inventory entries:
        // purchased = qty on purchase vouchers, sold = qty on sales vouchers
        // (qty is stored absolute; the voucher type gives the direction). current
        // = the Tally closing balance (products.opening_stock); opening is then
        // back-derived (current − purchased + sold).
        const names = productRows.map((r) => String(r.product || '').toLowerCase());
        const moves = {};
        if (names.length) {
            const mrows = await db('tally_inventory_entries as ie')
                .join('invoices as iv', function joinIv() {
                    this.on('iv.tally_guid', 'ie.voucher_guid').andOn('iv.company_id', 'ie.company_id');
                })
                .where('ie.company_id', companyId)
                .whereNull('iv.deleted_at')
                .whereRaw('lower(ie.item_name) = ANY(?)', [names])
                .select(db.raw('lower(ie.item_name) as item_name'))
                .select(db.raw("SUM(ie.qty) FILTER (WHERE iv.type='purchase') as purchased"))
                .select(db.raw("SUM(ie.qty) FILTER (WHERE iv.type='sales') as sold"))
                .groupByRaw('lower(ie.item_name)');
            mrows.forEach((m) => { moves[String(m.item_name || '').toLowerCase()] = m; });
        }

        const data = productRows.map((row) => {
            const m = moves[String(row.product || '').toLowerCase()] || {};
            const purchased = num(m.purchased);
            const sold      = num(m.sold);
            const current   = num(row.opening);             // Tally closing balance
            const opening    = Math.round((current - purchased + sold) * 1000) / 1000;
            const rate       = num(row.purchase_price) || num(row.sales_price);
            return {
                id:           row.id,
                product:      row.product,
                sku:          row.sku,
                category:     row.category,
                unit:         row.unit,
                hsn:          row.hsn,
                reorder_level: LOW_STOCK_LIMIT,
                opening,
                purchased,
                sold,
                current,
                value:        Math.round(rate * current * 100) / 100,
                status_label: statusLabel(current),
            };
        });

        return R.successResponse(res, {
            stats,
            data,
            meta: { total, page, per_page: perPage },
        });
    } catch (err) {
        console.error('inventory.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /inventory/adjust — manual stock adjustment.
 * Updates the product's opening_stock (what the list reads as "current") by the
 * requested delta and records an audit row in stock_adjustments — both in ONE
 * transaction. type: add (+qty) | remove (−qty, floored at 0) | set (=qty).
 */
async function adjust(req, res) {
    try {
        const b = req.body;
        const product = await db('products')
            .where({ id: b.product_id, company_id: req.companyId })
            .whereNull('deleted_at')
            .first('id', 'name', 'opening_stock');
        if (!product) return R.errorResponse(res, 'Product not found.', 404);

        const before = num(product.opening_stock);
        const qty    = num(b.quantity);
        let after;
        if (b.type === 'add')         after = before + qty;
        else if (b.type === 'remove') after = Math.max(0, before - qty);
        else                          after = qty;     // 'set'

        await db.transaction(async (trx) => {
            await trx('products').where('id', product.id)
                .update({ opening_stock: after, updated_at: new Date() });
            await trx('stock_adjustments').insert({
                company_id:      req.companyId,
                product_id:      product.id,
                // Location scoping: a location-restricted user's adjustment is
                // pinned to THEIR location (overriding any body value); an
                // unrestricted user keeps the chosen/blank location_id. (The
                // inventory LIST is derived from products, which carry no
                // location_id, so it is not location-filterable — only the
                // adjustment audit row records the branch.)
                location_id:     req.locationId != null ? req.locationId : (b.location_id || null),
                type:            b.type,
                quantity:        qty,
                before_qty:      before,
                after_qty:       after,
                reason:          b.reason || null,
                notes:           b.notes || null,
                adjustment_date: b.date || null,
                created_by:      req.user ? req.user.sub : null,
            });
        });

        return R.successResponse(res,
            { product_id: product.id, product: product.name, before, after },
            `Stock adjusted: ${product.name} ${before} → ${after}.`);
    } catch (err) {
        console.error('inventory.adjust error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, adjust };
