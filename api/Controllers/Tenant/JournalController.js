'use strict';

/**
 * api/Controllers/Tenant/JournalController.js
 *
 * Journal vouchers — a two-ledger accounting entry (Dr/Cr). Bespoke (not
 * crudController) because create auto-numbers the voucher (JV-0001) and stamps
 * the pending_tally status so the sync agent picks it up for Tally.
 *
 *   list    GET    /journals
 *   create  POST   /journals
 *   destroy DELETE /journals/:id   (soft delete)
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND = 'Journal not found.';
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        let qb = db('journals').where('company_id', req.companyId).whereNull('deleted_at');
        if (req.query.status) qb = qb.where('status', req.query.status);
        if (req.query.search) {
            const like = `%${String(req.query.search).trim()}%`;
            qb = qb.where((b) => {
                b.where('voucher_no', 'ilike', like)
                    .orWhere('dr_ledger', 'ilike', like)
                    .orWhere('cr_ledger', 'ilike', like)
                    .orWhere('narration', 'ilike', like);
            });
        }
        if (req.query.date_from) qb = qb.where('journal_date', '>=', req.query.date_from);
        if (req.query.date_to)   qb = qb.where('journal_date', '<=', req.query.date_to);
        const [{ count }] = await qb.clone().clearSelect().clearOrder().count({ count: '*' });
        const sumRow = await qb.clone().clearSelect().clearOrder().sum({ t: 'amount' }).first();
        const grandTotal = Number(sumRow ? sumRow.t : 0) || 0;
        const rows = await qb
            .orderBy('id', 'desc').limit(perPage).offset((page - 1) * perPage)
            .select('id', 'voucher_no', 'vch_type', 'journal_date', 'dr_ledger', 'cr_ledger', 'amount', 'narration', 'status', 'created_at');
        return R.successResponse(res, { data: rows, meta: { total: Number(count), page, per_page: perPage, grand_total: grandTotal } });
    } catch (err) {
        console.error('journals.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /api/v1/journals/monthly — month-wise Journal Register summary. */
async function monthly(req, res) {
    try {
        const money = (x) => Number(Number(x || 0).toFixed(2));
        let qb = db('journals').where('company_id', req.companyId).whereNull('deleted_at');
        if (req.query.date_from) qb = qb.where('journal_date', '>=', req.query.date_from);
        if (req.query.date_to)   qb = qb.where('journal_date', '<=', req.query.date_to);
        const rows = await qb
            .select(db.raw("to_char(journal_date, 'YYYY-MM') as month"))
            .sum('amount as total').count('id as count')
            .groupByRaw("to_char(journal_date, 'YYYY-MM')")
            .orderByRaw("to_char(journal_date, 'YYYY-MM')");
        let running = 0;
        const months = rows.map((r) => {
            running += Number(r.total) || 0;
            return { month: r.month, total: money(r.total), count: Number(r.count) || 0, closing: money(running) };
        });
        return R.successResponse(res, { data: months, meta: { grand_total: money(running), months: months.length } });
    } catch (err) {
        console.error('journals.monthly error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const b = req.body;
        // Auto-number JV-0001 (per company).
        const [{ count }] = await db('journals').where('company_id', req.companyId).count({ count: '*' });
        const voucherNo = 'JV-' + String(Number(count) + 1).padStart(4, '0');
        const now = new Date();
        const insertRow = {
            company_id: req.companyId, voucher_no: voucherNo, vch_type: b.vch_type || 'Journal',
            journal_date: b.journal_date,
            dr_ledger: b.dr_ledger, cr_ledger: b.cr_ledger, amount: b.amount,
            narration: b.narration || null, status: 'pending_tally',
            created_by: req.user ? req.user.sub : null, created_at: now, updated_at: now,
        };
        const [row] = await db('journals').insert(insertRow)
            .returning(['id', 'voucher_no', 'amount', 'status']);

        // HISTORY (best-effort): a cloud-side journal create. The full insert
        // payload (+ the generated id) is the after snapshot.
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'journals',
            record_type: 'journal',
            record_id:   row ? row.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       { id: row ? row.id : null, ...insertRow },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, row, 'Journal voucher created.');
    } catch (err) {
        console.error('journals.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    try {
        const id = Number(req.params.id);
        const existing = await db('journals').where({ id, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!existing) return R.errorResponse(res, NOT_FOUND, 404);
        const now = new Date();
        await db('journals').where('id', id).update({ deleted_at: now, updated_at: now });

        // HISTORY (best-effort): a cloud-side journal delete.
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'journals',
            record_type: 'journal',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Journal deleted.');
    } catch (err) {
        console.error('journals.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, monthly, create, destroy };
