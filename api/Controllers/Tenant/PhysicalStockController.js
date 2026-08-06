'use strict';

/**
 * api/Controllers/Tenant/PhysicalStockController.js
 *
 * Physical Stock — a GOODS voucher recording a physical count. It has NO
 * header table of its own: one "sheet" is simply the set of
 * `stock_adjustments` rows sharing one `voucher_no`
 * (voucher_kind='physical_stock'), the same audit table
 * InventoryController.adjust already writes to. create() SETS each counted
 * product's `products.opening_stock` to the counted quantity (type='set') and
 * writes one audit row per line, all inside one transaction — exactly
 * InventoryController.adjust's 'set' path, just looped over many products
 * under one shared voucher_no.
 *
 * normaliseCounts (pure/exported for the unit test) floors any negative
 * counted_qty to 0 — a physical count can never be negative.
 *
 * list() groups stock_adjustments by voucher_no so one sheet = one row
 * (date, voucher number, item count, who created it). get() returns one
 * sheet's full line detail.
 *
 * There is NO delete here, deliberately: erasing count history would be
 * wrong (it is evidence of what was physically counted on that date); a
 * correction is made by recording a NEW physical-stock sheet.
 *
 * Scoping matches every other tenant controller: req.companyId (+
 * req.locationId) and soft-delete is not applicable (stock_adjustments rows
 * are never soft-deleted).
 *
 * Exports: { list, get, create, normaliseCounts }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Physical stock sheet not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

function num(x) {
    return Number(x || 0);
}

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_LIMIT;
    if (perPage > MAX_LIMIT) perPage = MAX_LIMIT;
    return { page, perPage };
}

/**
 * Pure helper — exported for the unit test. Floors any negative counted_qty
 * to 0; a physical count can never be negative.
 */
function normaliseCounts(rows) {
    return (rows || []).map((r) => ({
        ...r,
        counted_qty: Math.max(0, Number(r.counted_qty) || 0),
    }));
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;

        let qb = db('stock_adjustments')
            .where('company_id', req.companyId)
            .where('voucher_kind', 'physical_stock');
        if (req.locationId != null) qb = qb.where('location_id', req.locationId);
        if (dateFrom) qb = qb.where('adjustment_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('adjustment_date', '<=', dateTo);

        // One sheet = one voucher_no. Total count is on the DISTINCT voucher
        // count, not the row count.
        const totalRow = await qb.clone()
            .countDistinct('voucher_no as c').first();
        const total = num(totalRow && totalRow.c);

        const voucherNos = await qb.clone()
            .groupBy('voucher_no')
            .orderBy('voucher_no', 'desc')
            .offset((page - 1) * perPage)
            .limit(perPage)
            .select('voucher_no');

        const nos = voucherNos.map((v) => v.voucher_no);
        let data = [];
        if (nos.length) {
            const grouped = await db('stock_adjustments')
                .where('company_id', req.companyId)
                .where('voucher_kind', 'physical_stock')
                .whereIn('voucher_no', nos)
                .select('voucher_no')
                .min('adjustment_date as count_date')
                .max('created_at as created_at')
                .count('id as items')
                .max('created_by as created_by')
                .groupBy('voucher_no')
                .orderBy('voucher_no', 'desc');
            data = grouped.map((g) => ({
                voucher_no: g.voucher_no,
                count_date: g.count_date,
                items:      num(g.items),
                created_by: g.created_by,
                created_at: g.created_at,
            }));
        }

        return R.successResponse(res, { data, meta: { total, page, per_page: perPage } });
    } catch (err) {
        console.error('physicalStock.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const voucherNo = String(req.params.voucher_no || '').trim();
    if (!voucherNo) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        let qb = db('stock_adjustments')
            .leftJoin('products', 'products.id', 'stock_adjustments.product_id')
            .where('stock_adjustments.company_id', req.companyId)
            .where('stock_adjustments.voucher_kind', 'physical_stock')
            .where('stock_adjustments.voucher_no', voucherNo);
        if (req.locationId != null) qb = qb.where('stock_adjustments.location_id', req.locationId);

        const items = await qb
            .orderBy('stock_adjustments.id', 'asc')
            .select(
                'stock_adjustments.*',
                'products.name as product_name',
                'products.sku as product_sku',
            );
        if (!items.length) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        return R.successResponse(res, {
            voucher_no: voucherNo,
            count_date: items[0].adjustment_date,
            created_by: items[0].created_by,
            items,
        });
    } catch (err) {
        console.error('physicalStock.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const body = req.body;
        const items = normaliseCounts(body.items || []);
        const createdBy = req.user && req.user.sub ? req.user.sub : null;
        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);

        const result = await db.transaction(async (trx) => {
            let voucherNo = (body.voucher_no || '').trim();
            if (!voucherNo) {
                const cntRow = await trx('stock_adjustments')
                    .where('company_id', req.companyId)
                    .where('voucher_kind', 'physical_stock')
                    .countDistinct('voucher_no as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.count_date || Date.now()).getFullYear();
                voucherNo = `PS-${year}-${String(seq).padStart(4, '0')}`;
            }

            const insertedRows = [];
            for (const it of items) {
                const product = await trx('products')
                    .where({ id: it.product_id, company_id: req.companyId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'name', 'opening_stock');
                if (!product) {
                    throw Object.assign(new Error('Product not found for physical stock line.'), { statusCode: 422 });
                }

                const before = num(product.opening_stock);
                const after  = it.counted_qty; // SET to the counted quantity

                await trx('products').where('id', product.id)
                    .update({ opening_stock: after, updated_at: new Date() });

                const [adjRow] = await trx('stock_adjustments').insert({
                    company_id:      req.companyId,
                    product_id:      product.id,
                    location_id:     effectiveLocationId,
                    type:            'set',
                    quantity:        after,
                    before_qty:      before,
                    after_qty:       after,
                    reason:          'Physical Stock',
                    notes:           it.godown || null,
                    voucher_no:      voucherNo,
                    voucher_kind:    'physical_stock',
                    // New sheets are pushable to Tally as soon as they are
                    // written. Old rows (created before this column existed)
                    // default to 'draft_cloud' via the migration and are
                    // never picked up by the push query — see
                    // 20260806120000_stock_adjustments_status.js.
                    status:          'pending_tally',
                    adjustment_date: body.count_date || null,
                    created_by:      createdBy,
                }).returning('*');
                insertedRows.push(adjRow);
            }

            return { voucher_no: voucherNo, count_date: body.count_date || null, items: insertedRows };
        });

        return R.successResponse(res, result, 'Physical stock recorded.');
    } catch (err) {
        if (err && err.statusCode === 422) {
            return R.errorResponse(res, err.message, 422);
        }
        console.error('physicalStock.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, normaliseCounts };
