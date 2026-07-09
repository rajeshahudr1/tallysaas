'use strict';

/**
 * api/Helpers/recurringInvoices.js
 *
 * Generate real sales invoices from recurring templates. One template = a
 * customer + a single line (description + amount + optional GST) + a schedule
 * (frequency + next_run_date). Reuses InvoiceController.computeTotals so the
 * line/header money math is IDENTICAL to a hand-cut invoice, and mirrors its
 * invoice_no sequence (INV-<year>-<0000>).
 */

const db = require('../config/db').db;
const { computeTotals } = require('../Controllers/Tenant/InvoiceController');

function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + Number(days || 0));
    return ymd(d);
}
function addByFrequency(dateStr, frequency) {
    const d = new Date(dateStr + 'T00:00:00');
    if (frequency === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
    else d.setMonth(d.getMonth() + 1);   // monthly (default)
    return ymd(d);
}
// Coerce a DB `date` value (pg returns a Date object, NOT a string) or a raw
// string into a clean 'YYYY-MM-DD'. String(Date).slice(0,10) would give "Mon
// Jun 01" — never do that.
function toYmd(v) {
    if (!v) return null;
    if (v instanceof Date) return ymd(v);
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ymd(new Date(s));
}

/** Create ONE sales invoice (header + single line) from a template, dated
 * `invoiceDate` (YYYY-MM-DD). Returns the inserted invoice row. */
async function generateOne(rec, invoiceDate) {
    return db.transaction(async (trx) => {
        const cntRow = await trx('invoices')
            .where('company_id', rec.company_id).where('type', 'sales').count('id as c').first();
        const seq = Number(cntRow ? cntRow.c : 0) + 1;
        const year = new Date(invoiceDate + 'T00:00:00').getFullYear();
        const invoiceNo = `INV-${year}-${String(seq).padStart(4, '0')}`;

        const items = [{
            description: rec.description || rec.title,
            quantity: 1,
            rate: Number(rec.amount) || 0,
            gst_rate: Number(rec.gst_rate) || 0,
        }];
        const { items: computedItems, totals } = computeTotals(items);
        const dueDate = addDays(invoiceDate, rec.due_days);

        const [inv] = await trx('invoices').insert({
            company_id:   rec.company_id,
            type:         'sales',
            invoice_no:   invoiceNo,
            customer_id:  rec.customer_id || null,
            invoice_date: invoiceDate,
            due_date:     dueDate,
            subtotal:     totals.subtotal,
            discount:     totals.discount,
            taxable:      totals.taxable,
            cgst:         totals.cgst,
            sgst:         totals.sgst,
            igst:         totals.igst,
            tax_amount:   totals.tax_amount,
            round_off:    totals.round_off,
            total:        totals.total,
            status:       'pending_tally',
            notes:        `Auto-generated — recurring: ${rec.title}`,
            created_by:   rec.created_by || null,
        }).returning('*');

        await trx('invoice_items').insert(computedItems.map((it) => ({
            company_id: rec.company_id, invoice_id: inv.id, ...it,
        })));
        return inv;
    });
}

/** Advance the template row after generating. */
async function advance(recId, nextRun, lastInvoiceId, newCount) {
    await db('recurring_invoices').where('id', recId).update({
        next_run_date:   nextRun,
        last_invoice_id: lastInvoiceId,
        last_run_at:     new Date(),
        generated_count: newCount,
        updated_at:      new Date(),
    });
}

/** Run one template up to today, catching up missed periods (bounded). Returns
 * the invoices generated. */
async function runRecurring(rec, asOf = new Date(), maxCatchUp = 12) {
    if (rec.status !== 'Active') return [];
    const today = ymd(asOf);
    let next = toYmd(rec.next_run_date);
    const end = toYmd(rec.end_date);
    const generated = [];
    let count = rec.generated_count || 0;
    let lastId = rec.last_invoice_id;

    while (next && next <= today && generated.length < maxCatchUp) {
        if (end && next > end) break;
        const inv = await generateOne(rec, next);
        generated.push(inv);
        lastId = inv.id;
        count += 1;
        next = addByFrequency(next, rec.frequency);
    }
    if (generated.length) await advance(rec.id, next, lastId, count);
    return generated;
}

/** Scheduler pass — generate every due invoice across all companies. */
async function runDueRecurring(asOf = new Date()) {
    const today = ymd(asOf);
    const due = await db('recurring_invoices')
        .whereNull('deleted_at').where('status', 'Active')
        .where('next_run_date', '<=', today)
        .select('*');
    let generated = 0;
    for (const rec of due) {
        try {
            const made = await runRecurring(rec, asOf);
            generated += made.length;
        } catch (e) {
            console.error('[recurring] generation failed for', rec.id, e && e.message);
        }
    }
    return { due: due.length, generated };
}

/** Manual "Generate now" — cut the NEXT scheduled period's invoice (dated on the
 * template's next_run_date) and advance the schedule one period. So repeated
 * clicks produce consecutive months (July, then August, then September, …),
 * matching the operator's expectation, instead of stacking many on today. Falls
 * back to today only when next_run_date is unset. Refuses to generate past the
 * template's end_date. */
async function generateNow(rec, asOf = new Date()) {
    const base = toYmd(rec.next_run_date) || ymd(asOf);
    const end = toYmd(rec.end_date);
    if (end && base > end) {
        const e = new Error('This recurring schedule has ended — no more invoices to generate.');
        e.code = 'RECURRING_ENDED';
        throw e;
    }
    const inv = await generateOne(rec, base);
    await advance(rec.id, addByFrequency(base, rec.frequency), inv.id, (rec.generated_count || 0) + 1);
    return inv;
}

module.exports = { generateOne, runRecurring, runDueRecurring, generateNow, addByFrequency, addDays };
