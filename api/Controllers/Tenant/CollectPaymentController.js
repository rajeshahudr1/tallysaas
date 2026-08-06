'use strict';

/**
 * api/Controllers/Tenant/CollectPaymentController.js
 *
 * Collect Payments — UPI-first, no payment gateway. A "payment request" is a
 * link the company sends a customer for one invoice; opening it shows a UPI
 * deep link built from the company's own VPA (Helpers/upiLink.js). The money
 * goes straight into the company's bank account — this platform never holds
 * or routes it, and never will via this table.
 *
 * We get NO confirmation a UPI transfer happened (no gateway = no webhook).
 * A request only becomes 'paid' when a human calls markPaid — that action
 * ALSO creates the receipt, atomically, in the same transaction. Nothing
 * here may infer payment from the public page being opened or time passing.
 *
 * Settings live under the tenant `settings` table's `collect_payments` key
 * (via SettingsController's same table — no new columns/tables for this):
 *   { enabled: boolean, upi_vpa: string, payee_name: string }
 *
 * A gateway hook (`gatewayStatus`) mirrors GstSearchController's
 * `lookupProvider` pattern: always reports not-configured today; the single
 * seam a future real gateway integration would replace.
 *
 * Exports: { getSettings, updateSettings, list, create, markPaid, cancel }
 */

const crypto = require('crypto');
const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const { recordHistory } = require('../../Helpers/history');
const { buildBills, buildBillwiseQuery, openingBillRows } = require('../../Helpers/billwiseOutstanding');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Payment request not found.';
const SETTINGS_KEY  = 'collect_payments';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_LIMIT;
    if (perPage > MAX_LIMIT) perPage = MAX_LIMIT;
    return { page, perPage };
}

/**
 * The single seam for a future real payment-gateway integration (auto
 * settlement confirmation etc). No gateway is wired up in this plan — it
 * always reports not_configured, same shape as GstSearchController's
 * lookupProvider. Swap this function's BODY, not its shape/callers, when a
 * real gateway is added. Must never fabricate a fake "available" response.
 */
async function gatewayStatus() {
    return { available: false, reason: 'not_configured' };
}

// Round to paise, same convention as billwiseOutstanding — a bill left at
// 0.0000001 due to float error must read as settled, not "outstanding".
function r2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * PURE — filters a list of bills down to the ones that still owe something.
 * Each row needs `total` and `paid` (paid defaults to 0 when absent — a bill
 * with no recorded payment is NOT an error, it's simply unpaid). Adds
 * `outstanding` = total - paid to every row that survives, rounded to paise.
 * A fully-paid or overpaid bill (paid >= total) is dropped entirely — never
 * offered for collection, and never shown with a negative due amount.
 *
 * Asking a customer to pay a bill they've already settled is worse than
 * useless, so this is the single gate every "which bills can we request
 * payment for" list must pass through.
 */
function outstandingOnly(rows) {
    return (rows || [])
        .map((r) => ({ ...r, outstanding: r2((Number(r.total) || 0) - (Number(r.paid) || 0)) }))
        .filter((r) => r.outstanding > 0);
}

/** Read the `collect_payments` settings blob for a company (defaults when unset). */
async function readSettings(companyId) {
    const row = await db('settings')
        .where({ company_id: companyId, key: SETTINGS_KEY })
        .first('value');
    const value = row ? row.value : null;
    return {
        enabled:     !!(value && value.enabled),
        upi_vpa:     (value && value.upi_vpa) || '',
        payee_name:  (value && value.payee_name) || '',
    };
}

/** GET /collect-payments/settings */
async function getSettings(req, res) {
    try {
        const settings = await readSettings(req.companyId);
        const gateway = await gatewayStatus();
        return R.successResponse(res, { settings, gateway });
    } catch (err) {
        console.error('collectPayments.getSettings error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** PUT /collect-payments/settings — body: { enabled, upi_vpa, payee_name } */
async function updateSettings(req, res) {
    try {
        const body = req.body || {};
        const settings = {
            enabled:    !!body.enabled,
            upi_vpa:    typeof body.upi_vpa === 'string' ? body.upi_vpa.trim() : '',
            payee_name: typeof body.payee_name === 'string' ? body.payee_name.trim() : '',
        };

        const now = new Date();
        const value = db.raw('?::jsonb', [JSON.stringify(settings)]);
        await db('settings')
            .insert({ company_id: req.companyId, key: SETTINGS_KEY, value, created_at: now, updated_at: now })
            .onConflict(['company_id', 'key'])
            .merge({ value, updated_at: now });

        return R.successResponse(res, { settings }, 'Settings saved.');
    } catch (err) {
        console.error('collectPayments.updateSettings error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /collect-payments/outstanding-invoices — feeds the "New Request" bill
 * picker. Only sales invoices that still owe something, each with how much.
 *
 * "How much is paid" is NOT read from `payments` — that table records a
 * receipt against a PARTY, not an invoice (see this file's header + Helpers/
 * billwiseOutstanding.js's header), so it cannot say what a SPECIFIC invoice
 * still owes. billwiseOutstanding already computes the exact per-bill balance
 * from Tally's own bill allocations, matched by bill name == invoice_no — so
 * that is reused here rather than re-deriving a second, possibly-different
 * outstanding figure. An invoice with no matching Tally bill allocation at
 * all (not yet synced, or synced but never referenced by a receipt) is
 * treated as fully outstanding — the safe default, since there is no
 * evidence anything against it was ever settled.
 */
async function outstandingInvoices(req, res) {
    try {
        const cid = req.companyId;

        let invQ = db('invoices')
            .leftJoin('customers', 'customers.id', 'invoices.customer_id')
            .where('invoices.company_id', cid)
            .where('invoices.type', 'sales')
            .whereNull('invoices.deleted_at');
        if (req.locationId != null) invQ = invQ.where('invoices.location_id', req.locationId);
        const invoices = await invQ
            .orderBy('invoices.id', 'desc')
            .select('invoices.id', 'invoices.invoice_no', 'invoices.total', 'customers.name as customer');

        const [billRows, openingRows] = await Promise.all([
            buildBillwiseQuery(db, cid),
            openingBillRows(db, cid),
        ]);
        const bills = buildBills([...billRows, ...openingRows]);
        const outstandingByBill = new Map();
        bills.forEach((b) => {
            if (b.outstanding > 0) outstandingByBill.set(String(b.bill).trim().toLowerCase(), b.outstanding);
        });

        const withPaid = invoices.map((inv) => {
            const total = Number(inv.total) || 0;
            const key = String(inv.invoice_no || '').trim().toLowerCase();
            const stillDue = outstandingByBill.has(key) ? outstandingByBill.get(key) : total;
            return { ...inv, total, paid: total - stillDue };
        });

        return R.successResponse(res, { data: outstandingOnly(withPaid) });
    } catch (err) {
        console.error('collectPayments.outstandingInvoices error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /collect-payments — list this company's requests. */
async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const status = (req.query.status || '').trim();

        let qb = db('payment_requests')
            .leftJoin('invoices', 'invoices.id', 'payment_requests.invoice_id')
            .leftJoin('customers', 'customers.id', 'payment_requests.customer_id')
            .where('payment_requests.company_id', req.companyId)
            .whereNull('payment_requests.deleted_at');

        if (status && status !== 'all') qb = qb.where('payment_requests.status', status);

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('payment_requests.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('payment_requests.id', 'desc')
            .select(
                'payment_requests.*',
                'invoices.invoice_no as invoice_no',
                'customers.name as customer',
            );

        return R.successResponse(res, { data: rows, meta: { total, page, per_page: perPage } });
    } catch (err) {
        console.error('collectPayments.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /collect-payments — body: { invoice_id, note? }
 * The amount is ALWAYS read from the invoice itself — anything the client
 * sends for amount is ignored (there is none in the accepted body shape).
 *
 * token shape: `<licenseId>.<48 hex chars>` — the licence id is not a secret
 * (it adds no guessability), it just lets the public GET /pay/:token route
 * (Public/PayController.show) parse straight to this one licence's tenant db
 * instead of fanning the lookup out across every active licence. All the
 * unguessability still comes from the random half: crypto.randomBytes(24),
 * same as before this prefix was added.
 */
async function create(req, res) {
    try {
        const invoiceId = Number(req.body && req.body.invoice_id);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
            return R.errorResponse(res, 'A valid invoice is required.', 422);
        }

        const invoice = await db('invoices')
            .where({ id: invoiceId, company_id: req.companyId })
            .whereNull('deleted_at')
            .first();
        if (!invoice) return R.errorResponse(res, 'Invoice not found.', 404);

        const licenseId = req.user && req.user.license_id;
        if (!Number.isInteger(licenseId) || licenseId <= 0) {
            return R.errorResponse(res, OOPS_MSG, 500);
        }
        const token = `${licenseId}.${crypto.randomBytes(24).toString('hex')}`;

        const row = {
            company_id:  req.companyId,
            invoice_id:  invoice.id,
            customer_id: invoice.customer_id || null,
            amount:      invoice.total,
            token,
            status:      'pending',
            note:        (req.body && req.body.note) ? String(req.body.note).trim() : null,
            created_by:  req.user && req.user.sub ? req.user.sub : null,
        };

        const [created] = await db('payment_requests').insert(row).returning('*');

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'collect-payments',
            record_type: 'payment_request',
            record_id:   created.id,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Payment request created.');
    } catch (err) {
        console.error('collectPayments.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /collect-payments/:id/mark-paid
 *
 * ONLY entry point that turns a request 'paid' — always a human action.
 * Same transaction: build the receipt (same shape PaymentController.
 * createByType writes for type='receipt' — voucher_no PAY/RCP sequence,
 * party_type 'customer', mode 'upi'), then ATOMICALLY claim the request with
 * a conditional UPDATE (`WHERE status = 'pending'`), mirroring
 * QuotationController.convert's claim pattern. 0 rows affected => someone
 * already marked it (or cancelled it) — throw to roll back the whole
 * transaction (so the receipt just inserted is undone too) and report 409.
 */
const ALREADY_CLAIMED = Symbol('payment-request-already-claimed');

async function markPaid(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const request = await db('payment_requests')
            .where({ id, company_id: req.companyId })
            .whereNull('deleted_at')
            .first();
        if (!request) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (request.status !== 'pending') {
            return R.errorResponse(res, `This request is already ${request.status}.`, 409);
        }

        let receiptRow;
        try {
            receiptRow = await db.transaction(async (trx) => {
                const paymentDate = new Date().toISOString().slice(0, 10);

                // Same voucher-number scheme PaymentController.nextVoucherNo uses
                // for type='receipt' (prefix RCP, year of payment_date, sequence =
                // count of this company's receipt rows + 1).
                const countRow = await trx('payments')
                    .where('company_id', req.companyId)
                    .where('type', 'receipt')
                    .count('id as c')
                    .first();
                const seq = Number(countRow ? countRow.c : 0) + 1;
                const year = new Date(paymentDate).getFullYear();
                const voucherNo = `RCP-${year}-${String(seq).padStart(4, '0')}`;

                const receiptHeader = {
                    company_id:   req.companyId,
                    type:         'receipt',
                    voucher_no:   voucherNo,
                    party_type:   'customer',
                    customer_id:  request.customer_id,
                    payment_date: paymentDate,
                    mode:         'upi',
                    reference:    `Collect Payment #${request.id}`,
                    amount:       request.amount,
                    status:       'pending_tally',
                    notes:        request.note || null,
                    created_by:   req.user && req.user.sub ? req.user.sub : null,
                };
                const [insertedReceipt] = await trx('payments').insert(receiptHeader).returning('*');

                const now = new Date();
                // Atomic claim: only succeeds while still 'pending'. 0 rows =>
                // a concurrent mark-paid/cancel already claimed this request;
                // throw to roll back the receipt insert above too, so a double
                // click can never create two receipts.
                const claimed = await trx('payment_requests')
                    .where({ id, company_id: req.companyId, status: 'pending' })
                    .update({
                        status:     'paid',
                        paid_at:    now,
                        paid_by:    req.user && req.user.sub ? req.user.sub : null,
                        receipt_id: insertedReceipt.id,
                        updated_at: now,
                    });
                if (!claimed) throw ALREADY_CLAIMED;

                return insertedReceipt;
            });
        } catch (err) {
            if (err === ALREADY_CLAIMED) {
                return R.errorResponse(res, 'This request was already settled.', 409);
            }
            throw err;
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'collect-payments',
            record_type: 'payment_request',
            record_id:   id,
            action:      'marked_paid',
            source:      'cloud',
            before:      request,
            after:       { status: 'paid', receipt_id: receiptRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { receipt_id: receiptRow.id }, 'Marked as paid.');
    } catch (err) {
        console.error('collectPayments.markPaid error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /collect-payments/:id/cancel */
async function cancel(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const existing = await db('payment_requests')
            .where({ id, company_id: req.companyId })
            .whereNull('deleted_at')
            .first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.status !== 'pending') {
            return R.errorResponse(res, `This request is already ${existing.status}.`, 409);
        }

        const now = new Date();
        const claimed = await db('payment_requests')
            .where({ id, company_id: req.companyId, status: 'pending' })
            .update({ status: 'cancelled', updated_at: now });
        if (!claimed) {
            return R.errorResponse(res, 'This request was already settled.', 409);
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'collect-payments',
            record_type: 'payment_request',
            record_id:   id,
            action:      'cancelled',
            source:      'cloud',
            before:      existing,
            after:       { status: 'cancelled' },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Payment request cancelled.');
    } catch (err) {
        console.error('collectPayments.cancel error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { getSettings, updateSettings, list, create, markPaid, cancel, outstandingOnly, outstandingInvoices };
