'use strict';

/**
 * api/Controllers/Tenant/PaymentController.js
 *
 * Custom tenant controller for the `payments` table (migration 20260101000018) —
 * the payment & receipt vouchers. Unlike customers/suppliers this resource is
 * NOT wired through Helpers/crudController, because it is two logical resources
 * over one table (split by `type`) and the create path computes a per-company,
 * per-type running voucher number that must never come from the client.
 *
 *   • type = 'payment'  → money OUT to a supplier (party_type 'supplier',
 *                          supplier_id populated). Listed at /payments.
 *   • type = 'receipt'  → money IN from a customer (party_type 'customer',
 *                          customer_id populated). Listed at /receipts.
 *
 * voucher_no is `PAY-<year>-NNNN` / `RCP-<year>-NNNN`, where the sequence is the
 * count of THIS company's rows of THIS type — INCLUDING soft-deleted ones, so a
 * deleted voucher never frees its number — plus one. Everything is scoped by
 * req.companyId (resolveCompany middleware) and ignores soft-deleted rows on read.
 *
 * Exports the six handlers used by Routes:
 *   { listPayments, listReceipts, get, createPayment, createReceipt, destroy }
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const { recordHistory } = require('../../Helpers/history');

// payments.type ('payment'|'receipt') → history module slug (matches the route
// slugs + HistoryController MODULE_TABLE).
const PAYMENT_MODULE_SLUG = { payment: 'payments', receipt: 'receipts' };

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND = 'Voucher not found.';

// Pagination bounds — mirror crudController so list shapes match everywhere.
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

// Columns returned by list/get. `payments.*` carries every base column; the
// COALESCE'd join surfaces a single friendly `party` label regardless of type.
const LIST_COLUMNS = [
    'payments.*',
    db.raw('COALESCE(suppliers.name, customers.name) as party'),
];

/**
 * Base query with BOTH party joins. The supplier join only matches payment rows
 * and the customer join only matches receipt rows, so exactly one contributes a
 * name per row (the other is NULL) — COALESCE picks the populated one.
 */
function baseQuery() {
    return db('payments')
        .leftJoin('suppliers', 'suppliers.id', 'payments.supplier_id')
        .leftJoin('customers', 'customers.id', 'payments.customer_id');
}

// Company-scoped, not-soft-deleted, single-type base query.
function scoped(companyId, type) {
    return baseQuery()
        .where('payments.company_id', companyId)
        .where('payments.type', type)
        .whereNull('payments.deleted_at');
}

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

/**
 * Compute the next voucher number for a company + type.
 *   prefix = 'PAY' (payment) | 'RCP' (receipt)
 *   year   = calendar year of the voucher's payment_date
 *   seq    = (count of existing rows for company_id + type, INCLUDING
 *            soft-deleted) + 1, zero-padded to 4.
 * Runs inside the create transaction so the count is consistent with the insert.
 */
async function nextVoucherNo(trx, companyId, type, paymentDate) {
    const prefix = type === 'payment' ? 'PAY' : 'RCP';
    const year   = new Date(paymentDate).getFullYear();

    const countRow = await trx('payments')
        .where('company_id', companyId)
        .where('type', type)
        .count('id as c')
        .first();

    const seq = Number(countRow ? countRow.c : 0) + 1;
    return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Shared list handler for both /payments and /receipts. `type` selects which
 * slice of the table is returned. Search spans voucher_no, the COALESCE'd party
 * name and reference; status / mode / date range narrow further. Returns the
 * `{ data, meta }` envelope crudController.list emits so clients see one shape.
 */
async function listByType(req, res, type) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search    = (req.query.search || '').trim();
        const status    = (req.query.status || '').trim();
        const mode      = (req.query.mode || '').trim();
        const dateFrom  = (req.query.date_from || '').trim();
        const dateTo    = (req.query.date_to || '').trim();

        let qb = scoped(req.companyId, type);

        if (status) qb = qb.where('payments.status', status);
        if (mode)   qb = qb.where('payments.mode', mode);
        if (dateFrom) qb = qb.where('payments.payment_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('payments.payment_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.orWhere('payments.voucher_no', 'ilike', like)
                    .orWhere('payments.reference', 'ilike', like)
                    .orWhere('suppliers.name', 'ilike', like)
                    .orWhere('customers.name', 'ilike', like);
            });
        }

        // Count BEFORE pagination — clone so offset/limit/select/order don't
        // leak into the count query.
        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('payments.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);
        const sumRow = await qb.clone().clearSelect().clearOrder()
            .sum('payments.amount as t').first();
        const grandTotal = Number(sumRow ? sumRow.t : 0) || 0;

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .select(...LIST_COLUMNS)
            .orderBy('payments.id', 'desc');

        // Synced vouchers are summary-only (party FK null) — reconstruct the party
        // name for THIS page from the postings: payment → the supplier (a debit),
        // receipt → the customer (a credit); the cash/bank leg is skipped.
        const guids = rows.map((r) => r.tally_guid).filter(Boolean);
        if (guids.length) {
            const isReceipt = type === 'receipt';
            const entries = await db('tally_voucher_entries')
                .where('company_id', req.companyId).whereIn('voucher_guid', guids)
                .select('voucher_guid', 'ledger_name', 'amount', 'is_debit');
            const agg = {};
            entries.forEach((e) => {
                const onParty = isReceipt ? !e.is_debit : !!e.is_debit;
                if (!onParty) return;
                const nm = String(e.ledger_name || '');
                if (/cash|bank/i.test(nm)) return;
                const abs = Math.abs(Number(e.amount) || 0);
                const a = agg[e.voucher_guid] || (agg[e.voucher_guid] = { party: '', abs: -1 });
                if (abs > a.abs) { a.party = nm; a.abs = abs; }
            });
            rows.forEach((r) => { if (!r.party && agg[r.tally_guid]) r.party = agg[r.tally_guid].party; });
        }

        return R.successResponse(res, {
            data: rows,
            meta: { total, page, per_page: perPage, grand_total: grandTotal },
        });
    } catch (err) {
        console.error(`payments.list (${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /api/v1/payments — money-out vouchers. */
async function listPayments(req, res) {
    return listByType(req, res, 'payment');
}

/** GET /api/v1/receipts — money-in vouchers. */
async function listReceipts(req, res) {
    return listByType(req, res, 'receipt');
}

/**
 * Month-wise summary for the Payment/Receipt Register: one row per calendar
 * month with the total + count and a running closing balance, plus the grand
 * total. Optional (draft) vouchers are excluded, matching Tally's registers.
 */
async function monthlyByType(req, res, type) {
    try {
        const money = (x) => Number(Number(x || 0).toFixed(2));
        let qb = db('payments')
            .where('payments.company_id', req.companyId)
            .where('payments.type', type)
            .whereNull('payments.deleted_at')
            .where('payments.tally_optional', false);
        if (req.query.date_from) qb = qb.where('payments.payment_date', '>=', req.query.date_from);
        if (req.query.date_to)   qb = qb.where('payments.payment_date', '<=', req.query.date_to);

        const rows = await qb
            .select(db.raw("to_char(payments.payment_date, 'YYYY-MM') as month"))
            .sum('payments.amount as total')
            .count('payments.id as count')
            .groupByRaw("to_char(payments.payment_date, 'YYYY-MM')")
            .orderByRaw("to_char(payments.payment_date, 'YYYY-MM')");

        let running = 0;
        const months = rows.map((r) => {
            running += Number(r.total) || 0;
            return { month: r.month, total: money(r.total), count: Number(r.count) || 0, closing: money(running) };
        });
        return R.successResponse(res, {
            data: months,
            meta: { grand_total: money(running), months: months.length },
        });
    } catch (err) {
        console.error(`payments.monthly(${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function monthlyPayments(req, res) { return monthlyByType(req, res, 'payment'); }
async function monthlyReceipts(req, res) { return monthlyByType(req, res, 'receipt'); }

/**
 * GET /api/v1/payments/:id (or /receipts/:id)
 * Returns the voucher joined with its party name. Not type-scoped — an id is
 * unique within the company — but still company-scoped + soft-delete aware.
 */
async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);
    try {
        const row = await baseQuery()
            .where('payments.company_id', req.companyId)
            .whereNull('payments.deleted_at')
            .where('payments.id', id)
            .select(...LIST_COLUMNS)
            .first();
        if (!row) return R.errorResponse(res, NOT_FOUND, 404);
        return R.successResponse(res, row);
    } catch (err) {
        console.error('payments.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * Shared create path. `type` is 'payment' or 'receipt'; `partyCol` is the FK the
 * validated body carries (supplier_id / customer_id) and `partyType` the matching
 * party_type label. The voucher number is computed inside the transaction so the
 * sequence count and the insert can't race against a concurrent create.
 */
async function createByType(req, res, { type, partyCol, partyType, successMsg }) {
    try {
        const body = req.body;

        const created = await db.transaction(async (trx) => {
            const voucherNo = await nextVoucherNo(trx, req.companyId, type, body.payment_date);

            const row = {
                company_id:   req.companyId,
                type,
                voucher_no:   voucherNo,
                party_type:   partyType,
                [partyCol]:   body[partyCol],
                payment_date: body.payment_date,
                mode:         body.mode,
                reference:    body.reference,
                bank_account: body.bank_account,
                amount:       body.amount,
                status:       body.status,
                notes:        body.notes,
                created_by:   req.user && req.user.sub,
            };

            const [inserted] = await trx('payments').insert(row).returning('*');
            return inserted;
        });

        // HISTORY (best-effort): a cloud-side payment/receipt create.
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      PAYMENT_MODULE_SLUG[type] || type,
            record_type: type,
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, successMsg);
    } catch (err) {
        console.error(`payments.create (${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /api/v1/payments — record money paid OUT to a supplier. */
async function createPayment(req, res) {
    return createByType(req, res, {
        type:       'payment',
        partyCol:   'supplier_id',
        partyType:  'supplier',
        successMsg: 'Payment created.',
    });
}

/** POST /api/v1/receipts — record money received IN from a customer. */
async function createReceipt(req, res) {
    return createByType(req, res, {
        type:       'receipt',
        partyCol:   'customer_id',
        partyType:  'customer',
        successMsg: 'Receipt created.',
    });
}

/**
 * DELETE /api/v1/payments/:id (or /receipts/:id)
 * Soft delete — stamps deleted_at; the row stays for audit and keeps its place
 * in the voucher-number sequence. Company-scoped existence check first.
 */
async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);
    try {
        const existing = await db('payments')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id)
            .first();
        if (!existing) return R.errorResponse(res, NOT_FOUND, 404);

        const now = new Date();
        await db('payments').where('id', id).update({ deleted_at: now, updated_at: now });

        // HISTORY (best-effort): a cloud-side payment/receipt delete.
        const vtype = String(existing.type || 'payment');
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      PAYMENT_MODULE_SLUG[vtype] || vtype,
            record_type: vtype,
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Voucher deleted.');
    } catch (err) {
        console.error('payments.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    listPayments,
    listReceipts,
    monthlyPayments,
    monthlyReceipts,
    get,
    createPayment,
    createReceipt,
    destroy,
};
