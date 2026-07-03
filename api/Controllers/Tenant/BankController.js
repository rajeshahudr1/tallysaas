'use strict';

/**
 * api/Controllers/Tenant/BankController.js
 *
 * Bank Reconciliation — import statement lines, auto-match to payment/receipt
 * vouchers, then list / manually match / unmatch / ignore.
 *
 *   import     POST   /bank/import            { rows:[{txn_date,description,reference,amount}] }
 *   list       GET    /bank/transactions      → lines + matched voucher + summary
 *   candidates GET    /bank/transactions/:id/candidates → matchable vouchers
 *   match      POST   /bank/transactions/:id/match   { payment_id }
 *   unmatch    POST   /bank/transactions/:id/unmatch
 *   ignore     POST   /bank/transactions/:id/ignore
 *   remove     DELETE /bank/transactions/:id
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { importAndMatch } = require('../../Helpers/bankReconcile');

const OOPS = 'Oops..Something went wrong. Please try again.';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function importTxns(req, res) {
    try {
        const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
        if (!rows.length) return R.errorResponse(res, 'No rows to import.', 422);
        if (rows.length > 5000) return R.errorResponse(res, 'Too many rows in one import (max 5000).', 422);
        const batch = 'B' + Date.now();
        const result = await importAndMatch(req.companyId, rows, batch);
        return R.successResponse(res, result,
            `Imported ${result.imported} transaction(s) — ${result.matched} auto-matched.`);
    } catch (err) {
        console.error('bank.import error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function list(req, res) {
    try {
        const companyId = req.companyId;
        const status = String(req.query.status || '').trim();

        let qb = db('bank_transactions as bt')
            .leftJoin('payments as p', 'p.id', 'bt.matched_id')
            .where('bt.company_id', companyId).whereNull('bt.deleted_at')
            .select('bt.*', 'p.voucher_no as matched_voucher', 'p.payment_date as matched_date')
            .orderBy('bt.txn_date', 'desc').orderBy('bt.id', 'desc');
        if (status) qb = qb.where('bt.status', status);
        const rows = await qb;

        const all = await db('bank_transactions').where('company_id', companyId).whereNull('deleted_at').select('status', 'amount');
        const summary = { total: all.length, matched: 0, unmatched: 0, ignored: 0, credit: 0, debit: 0 };
        for (const r of all) {
            summary[r.status] = (summary[r.status] || 0) + 1;
            const amt = Number(r.amount) || 0;
            if (amt >= 0) summary.credit += amt; else summary.debit += Math.abs(amt);
        }
        summary.credit = r2(summary.credit);
        summary.debit = r2(summary.debit);
        return R.successResponse(res, { data: rows, summary });
    } catch (err) {
        console.error('bank.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function candidates(req, res) {
    try {
        const id = Number(req.params.id);
        const bt = await db('bank_transactions').where({ id, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!bt) return R.errorResponse(res, 'Transaction not found.', 404);
        const type = bt.direction === 'credit' ? 'receipt' : 'payment';
        const abs = Math.abs(Number(bt.amount) || 0);

        // Vouchers of this type already claimed by ANOTHER bank line.
        const claimed = db('bank_transactions')
            .where({ company_id: req.companyId, matched_type: type })
            .whereNotNull('matched_id').whereNull('deleted_at').whereNot('id', id)
            .select('matched_id');

        const cands = await db('payments as p')
            .leftJoin('customers as c', 'c.id', 'p.customer_id')
            .leftJoin('suppliers as s', 's.id', 'p.supplier_id')
            .where({ 'p.company_id': req.companyId, 'p.type': type }).whereNull('p.deleted_at')
            .whereNotIn('p.id', claimed)
            .select('p.id', 'p.voucher_no', 'p.amount', 'p.payment_date', db.raw('coalesce(c.name, s.name) as party'))
            .orderByRaw('abs(p.amount - ?) asc', [abs]).orderBy('p.payment_date', 'desc').limit(25);
        return R.successResponse(res, { data: cands, type });
    } catch (err) {
        console.error('bank.candidates error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function match(req, res) {
    try {
        const id = Number(req.params.id);
        const paymentId = Number(req.body && req.body.payment_id);
        const bt = await db('bank_transactions').where({ id, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!bt) return R.errorResponse(res, 'Transaction not found.', 404);
        const type = bt.direction === 'credit' ? 'receipt' : 'payment';
        const pay = await db('payments').where({ id: paymentId, company_id: req.companyId, type }).whereNull('deleted_at').first('id');
        if (!pay) return R.errorResponse(res, 'That voucher was not found (or is the wrong type).', 422);
        await db('bank_transactions').where('id', id).update({
            status: 'matched', matched_type: type, matched_id: paymentId, matched_at: new Date(), updated_at: new Date(),
        });
        return R.successResponse(res, { id }, 'Matched.');
    } catch (err) {
        console.error('bank.match error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function setStatus(req, res, status) {
    try {
        const id = Number(req.params.id);
        const patch = status === 'unmatched'
            ? { status, matched_type: null, matched_id: null, matched_at: null, updated_at: new Date() }
            : { status, matched_type: null, matched_id: null, updated_at: new Date() };
        const n = await db('bank_transactions').where({ id, company_id: req.companyId }).whereNull('deleted_at').update(patch);
        if (!n) return R.errorResponse(res, 'Transaction not found.', 404);
        return R.successResponse(res, { id }, status === 'unmatched' ? 'Unmatched.' : 'Ignored.');
    } catch (err) {
        console.error('bank.setStatus error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}
const unmatch = (req, res) => setStatus(req, res, 'unmatched');
const ignore  = (req, res) => setStatus(req, res, 'ignored');

async function remove(req, res) {
    try {
        const id = Number(req.params.id);
        const n = await db('bank_transactions').where({ id, company_id: req.companyId }).whereNull('deleted_at')
            .update({ deleted_at: new Date(), updated_at: new Date() });
        if (!n) return R.errorResponse(res, 'Transaction not found.', 404);
        return R.successResponse(res, { id }, 'Removed.');
    } catch (err) {
        console.error('bank.remove error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { importTxns, list, candidates, match, unmatch, ignore, remove };
