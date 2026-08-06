'use strict';

/**
 * api/Controllers/Tenant/StockJournalController.js
 *
 * Stock Journal — a GOODS voucher (no ledger / GST / money totals). It moves
 * stock between items (consumption/production transfer), the same way
 * InventoryController.adjust already moves stock: mutate
 * `products.opening_stock` and write an audit row into `stock_adjustments`,
 * both inside ONE transaction. This controller does NOT invent a parallel
 * stock ledger.
 *
 * A journal's own header/items live in `stock_journals` / `stock_journal_items`
 * (see 20260806040000_stock_vouchers.js) so the voucher itself is inspectable
 * and re-syncable to Tally; the ACTUAL stock effect is the paired
 * stock_adjustments rows (voucher_kind='stock_journal', voucher_no=<this
 * voucher's number>) — one row per journal line, `type` derived from
 * `direction` ('source' -> 'remove', 'destination' -> 'add').
 *
 * Balance rule (isBalanced, pure/exported for the unit test): total source
 * quantity must equal total destination quantity; NO destination at all is
 * valid (pure consumption); destination-only (nothing sourced) is NOT valid.
 *
 * create() runs the whole write — items insert, per-line opening_stock
 * mutation, per-line stock_adjustments audit row — inside one transaction. If
 * any `source` line would drive a product's stock negative, the WHOLE voucher
 * 422s (nothing partially applies — the transaction simply never commits).
 *
 * destroy() soft-deletes the journal AND reverses every stock effect it
 * caused (opposite direction, with its own audit trail) — otherwise the
 * voucher vanishes from list() while its stock effect silently remains.
 *
 * Scoping matches every other tenant controller: req.companyId (+
 * req.locationId via stock_adjustments.location_id) and soft-delete
 * exclusion (deleted_at IS NULL).
 *
 * Exports: { list, get, create, destroy, isBalanced }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Stock journal not found.';
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
 * Pure balance check — exported for the unit test. `items` is the raw
 * (validated) items array: [{ direction: 'source'|'destination', quantity }].
 *   - source total === destination total  -> balanced (transfer)
 *   - destination total === 0             -> balanced (pure consumption)
 *   - source total === 0 (destination-only) -> NOT balanced (stock from nowhere)
 */
function isBalanced(items) {
    let sourceQty = 0, destQty = 0;
    for (const it of (items || [])) {
        const qty = Number(it.quantity) || 0;
        if (it.direction === 'source') sourceQty += qty;
        else if (it.direction === 'destination') destQty += qty;
    }
    if (sourceQty === 0) return destQty === 0;  // destination-only (or both empty)
    if (destQty === 0) return true;             // pure consumption: no destination
    return Math.abs(sourceQty - destQty) < 1e-9;
}

function baseQuery() {
    return db('stock_journals');
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;

        let qb = baseQuery()
            .where('company_id', req.companyId)
            .whereNull('deleted_at');

        if (search) qb = qb.where('voucher_no', 'ilike', `%${search}%`);
        if (dateFrom) qb = qb.where('journal_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('journal_date', '<=', dateTo);

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('id as c').first();
        const total = num(totalRow && totalRow.c);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('id', 'desc')
            .select('*');

        return R.successResponse(res, { data: rows, meta: { total, page, per_page: perPage } });
    } catch (err) {
        console.error('stockJournals.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const journal = await baseQuery()
            .where({ id, company_id: req.companyId })
            .whereNull('deleted_at')
            .first('*');
        if (!journal) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('stock_journal_items')
            .where({ company_id: req.companyId, stock_journal_id: id })
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...journal, items });
    } catch (err) {
        console.error('stockJournals.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const body = req.body;
        const items = body.items || [];

        if (!isBalanced(items)) {
            return R.errorResponse(res, 'Stock journal is not balanced: source quantity must equal destination quantity (or have no destination for pure consumption).', 422);
        }

        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);
        const createdBy = req.user && req.user.sub ? req.user.sub : null;

        const result = await db.transaction(async (trx) => {
            let voucherNo = (body.voucher_no || '').trim();
            if (!voucherNo) {
                const cntRow = await trx('stock_journals')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.journal_date || Date.now()).getFullYear();
                voucherNo = `SJ-${year}-${String(seq).padStart(4, '0')}`;
            }

            const [journalRow] = await trx('stock_journals').insert({
                company_id:   req.companyId,
                voucher_no:   voucherNo,
                journal_date: body.journal_date || null,
                narration:    body.narration || null,
                created_by:   createdBy,
            }).returning('*');

            const itemRows = items.map((it) => ({
                company_id:        req.companyId,
                stock_journal_id:  journalRow.id,
                product_id:        it.product_id,
                direction:         it.direction,
                godown:            it.godown || null,
                quantity:          Number(it.quantity) || 0,
                rate:              it.rate != null && it.rate !== '' ? Number(it.rate) : null,
            }));
            const insertedItems = itemRows.length
                ? await trx('stock_journal_items').insert(itemRows).returning('*') : [];

            // Move stock exactly like InventoryController.adjust: mutate
            // products.opening_stock + write a stock_adjustments audit row,
            // one per line. 'source' removes stock, 'destination' adds it.
            for (const it of insertedItems) {
                const product = await trx('products')
                    .where({ id: it.product_id, company_id: req.companyId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'name', 'opening_stock');
                if (!product) {
                    throw Object.assign(new Error('Product not found for stock journal line.'), { statusCode: 422 });
                }

                const before = num(product.opening_stock);
                const qty    = num(it.quantity);
                let after, adjType;
                if (it.direction === 'source') {
                    after = before - qty;
                    adjType = 'remove';
                    if (after < 0) {
                        throw Object.assign(
                            new Error(`Insufficient stock for "${product.name}": have ${before}, need ${qty}.`),
                            { statusCode: 422 },
                        );
                    }
                } else {
                    after = before + qty;
                    adjType = 'add';
                }

                await trx('products').where('id', product.id)
                    .update({ opening_stock: after, updated_at: new Date() });

                await trx('stock_adjustments').insert({
                    company_id:      req.companyId,
                    product_id:      product.id,
                    location_id:     effectiveLocationId,
                    type:            adjType,
                    quantity:        qty,
                    before_qty:      before,
                    after_qty:       after,
                    reason:          'Stock Journal',
                    voucher_no:      voucherNo,
                    voucher_kind:    'stock_journal',
                    adjustment_date: body.journal_date || null,
                    created_by:      createdBy,
                });
            }

            return { ...journalRow, items: insertedItems };
        });

        return R.successResponse(res, result, 'Stock journal created.');
    } catch (err) {
        if (err && err.statusCode === 422) {
            return R.errorResponse(res, err.message, 422);
        }
        if (err && err.code === '23505' && /stock_journals_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Voucher No "${(req.body.voucher_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
        console.error('stockJournals.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const existing = await db('stock_journals')
            .where({ id, company_id: req.companyId })
            .whereNull('deleted_at')
            .first('*');
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('stock_journal_items')
            .where({ company_id: req.companyId, stock_journal_id: id })
            .select('*');
        const createdBy = req.user && req.user.sub ? req.user.sub : null;

        await db.transaction(async (trx) => {
            const now = new Date();
            await trx('stock_journals').where('id', id)
                .update({ deleted_at: now, updated_at: now });

            // Reverse every stock effect this voucher caused, opposite
            // direction, with its own audit row — otherwise the voucher
            // vanishes from list() while stock stays wrong.
            for (const it of items) {
                const product = await trx('products')
                    .where({ id: it.product_id, company_id: req.companyId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'opening_stock');
                if (!product) continue;

                const before = num(product.opening_stock);
                const qty    = num(it.quantity);
                // Reverse of source(remove) is add-back; reverse of
                // destination(add) is remove.
                const isReversalAdd = it.direction === 'source';
                const after = isReversalAdd ? before + qty : Math.max(0, before - qty);

                await trx('products').where('id', product.id)
                    .update({ opening_stock: after, updated_at: now });

                await trx('stock_adjustments').insert({
                    company_id:      req.companyId,
                    product_id:      product.id,
                    location_id:     req.locationId != null ? req.locationId : null,
                    type:            isReversalAdd ? 'add' : 'remove',
                    quantity:        qty,
                    before_qty:      before,
                    after_qty:       after,
                    reason:          'Stock Journal deleted (reversal)',
                    voucher_no:      existing.voucher_no,
                    voucher_kind:    'stock_journal',
                    adjustment_date: now.toISOString().slice(0, 10),
                    created_by:      createdBy,
                });
            }
        });

        return R.successResponse(res, { id }, 'Stock journal deleted.');
    } catch (err) {
        console.error('stockJournals.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, destroy, isBalanced };
