'use strict';

/**
 * api/Helpers/receivablesAgeing.js
 *
 * Turns raw sales invoices + receipt vouchers into the dashboard's Receivables
 * panel: an ageing breakdown, the overdue total, and near-term projections.
 *
 * Why FIFO, in memory: `payments` records a receipt against a PARTY, not an
 * invoice, so per-invoice settlement does not exist in the schema. We therefore
 * apply each customer's total receipts to their OLDEST open invoices first —
 * the same convention Tally uses when a receipt carries no bill reference. The
 * work is a couple of passes over the open invoices, so it runs in the API
 * process rather than as a window-function query, and stays unit-testable.
 *
 * PURE — no db access.
 */

// Ageing bands, in days since the invoice date. `max` is inclusive; the final
// band is open-ended (max === Infinity).
const BUCKETS = [
    { label: '0 - 45 Days',    max: 45 },
    { label: '45 - 90 Days',   max: 90 },
    { label: '90 - 135 Days',  max: 135 },
    { label: '135 - 180 Days', max: 180 },
    { label: '180 - 225 Days', max: 225 },
    { label: '> 225 Days',     max: Infinity },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse a 'YYYY-MM-DD' string (or Date) into a local midnight Date, or null.
function asDate(v) {
    if (!v) return null;
    if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Whole days between two local-midnight dates (b - a).
function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Which ageing band a given age (in days) falls into. A boundary day belongs
 * to the LOWER band — 45 days is "0 - 45", 46 days is "45 - 90".
 */
function bucketIndexForDays(days) {
    for (let i = 0; i < BUCKETS.length; i += 1) {
        if (days <= BUCKETS[i].max) return i;
    }
    return BUCKETS.length - 1;
}

/**
 * Apply `received` to `invoices` oldest-first.
 * @param {Array<{invoice_date, total}>} invoices  one customer's invoices
 * @param {number} received  that customer's total receipts
 * @returns {Array<{...invoice, outstanding:number}>} in the input order
 */
function allocateFifo(invoices, received) {
    // Settle in date order, but return in the caller's order so the caller can
    // keep its own indexing.
    const order = invoices
        .map((v, i) => ({ i, d: asDate(v.invoice_date) }))
        .sort((a, b) => {
            if (!a.d) return 1;
            if (!b.d) return -1;
            return a.d - b.d;
        });

    const out = invoices.map((v) => ({ ...v, outstanding: Number(v.total || 0) }));
    let pool = Number(received || 0);

    for (const { i } of order) {
        if (pool <= 0) break;
        const take = Math.min(pool, out[i].outstanding);
        out[i].outstanding -= take;
        pool -= take;
    }
    return out;
}

/**
 * Build the whole Receivables payload.
 *
 * @param {Array<{customer_id, invoice_date, due_date, total}>} invoices
 *        every OPEN sales invoice (already company/location scoped)
 * @param {Array<{customer_id, amount}>} receipts  receipt vouchers
 * @param {Date} now  "today" — passed in so the result is testable
 * @returns {{
 *   total:number, overdue:number, projection_15:number, projection_60:number,
 *   buckets: Array<{label:string, amount:number}>
 * }}
 */
function buildReceivables(invoices, receipts, now) {
    const today = asDate(now instanceof Date ? now : new Date());

    // Sum receipts per customer once, then allocate customer by customer.
    const receivedBy = new Map();
    for (const r of receipts || []) {
        const key = String(r.customer_id);
        receivedBy.set(key, (receivedBy.get(key) || 0) + Number(r.amount || 0));
    }

    const byCustomer = new Map();
    for (const v of invoices || []) {
        const key = String(v.customer_id);
        if (!byCustomer.has(key)) byCustomer.set(key, []);
        byCustomer.get(key).push(v);
    }

    const buckets = BUCKETS.map((b) => ({ label: b.label, amount: 0 }));
    let total = 0;
    let overdue = 0;
    let projection15 = 0;
    let projection60 = 0;

    for (const [key, list] of byCustomer.entries()) {
        const settled = allocateFifo(list, receivedBy.get(key) || 0);

        for (const row of settled) {
            const open = row.outstanding;
            if (open <= 0) continue;

            total += open;

            const issued = asDate(row.invoice_date);
            const age = issued ? Math.max(0, daysBetween(issued, today)) : 0;
            buckets[bucketIndexForDays(age)].amount += open;

            // Overdue + projections are due-date driven. An invoice with no due
            // date is neither overdue nor projected — we have no date to judge.
            const due = asDate(row.due_date);
            if (!due) continue;
            const daysToDue = daysBetween(today, due);
            if (daysToDue < 0) {
                overdue += open;
            } else {
                if (daysToDue <= 15) projection15 += open;
                if (daysToDue <= 60) projection60 += open;
            }
        }
    }

    return {
        total,
        overdue,
        projection_15: projection15,
        projection_60: projection60,
        buckets,
    };
}

/**
 * Same walk as buildReceivables(), but returns the underlying OPEN invoice
 * rows themselves — each tagged with its bucket — instead of the rolled-up
 * totals. This is what powers the dashboard's ageing-bucket drill-down:
 * filtering this list to one bucket_index and summing `outstanding`
 * reproduces EXACTLY the amount buildReceivables() put in that bucket,
 * because both walk the same FIFO allocation over the same BUCKETS/
 * bucketIndexForDays. Never re-derive the boundaries anywhere else — that is
 * how the dashboard total and a drill-down list end up disagreeing.
 *
 * Any extra fields the caller put on an invoice row (id, invoice_no,
 * customer name, ...) pass through untouched via the `{ ...row }` spread.
 *
 * PURE — no db access.
 *
 * @param {Array<{customer_id, invoice_date, due_date, total}>} invoices
 * @param {Array<{customer_id, amount}>} receipts
 * @param {Date} now  "today" — passed in so the result is testable
 * @returns {Array<{...invoice, outstanding:number, age_days:number,
 *                   bucket_index:number, bucket_label:string}>}
 *          Only rows with outstanding > 0. Order follows the input's
 *          per-customer grouping, not sorted by age — callers that need a
 *          particular order (e.g. oldest first) should sort themselves.
 */
function buildReceivablesRows(invoices, receipts, now) {
    const today = asDate(now instanceof Date ? now : new Date());

    const receivedBy = new Map();
    for (const r of receipts || []) {
        const key = String(r.customer_id);
        receivedBy.set(key, (receivedBy.get(key) || 0) + Number(r.amount || 0));
    }

    const byCustomer = new Map();
    for (const v of invoices || []) {
        const key = String(v.customer_id);
        if (!byCustomer.has(key)) byCustomer.set(key, []);
        byCustomer.get(key).push(v);
    }

    const out = [];
    for (const [key, list] of byCustomer.entries()) {
        const settled = allocateFifo(list, receivedBy.get(key) || 0);

        for (const row of settled) {
            const open = row.outstanding;
            if (open <= 0) continue;

            const issued = asDate(row.invoice_date);
            const age = issued ? Math.max(0, daysBetween(issued, today)) : 0;
            const idx = bucketIndexForDays(age);

            out.push({
                ...row,
                outstanding: open,
                age_days: age,
                bucket_index: idx,
                bucket_label: BUCKETS[idx].label,
            });
        }
    }
    return out;
}

module.exports = {
    BUCKETS, bucketIndexForDays, allocateFifo, buildReceivables, buildReceivablesRows,
};
