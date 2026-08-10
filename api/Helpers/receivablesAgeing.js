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
 * When a bill is due.
 *
 * A bill with no due date is due ON ITS INVOICE DATE — a party with no agreed
 * credit period owes the money immediately. That is what Tally does with a
 * zero credit period, and what LiveKeeping shows (a party whose bills carry
 * no terms reports Overdue equal to Outstanding). Treating a missing due date
 * as "never overdue" instead would quietly hide the oldest debts on the very
 * screen built to surface them.
 *
 * Note this is deliberately NOT symmetric with `credit_days`, which stays
 * null for such a bill: we know the money is due, we do NOT know the party
 * was ever granted terms, and reporting "0 days credit" would read as a
 * negotiated term rather than as missing data.
 */
function dueDateOf(row) {
    return asDate(row.due_date) || asDate(row.invoice_date);
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

            // Overdue + projections are due-date driven; a bill with no stated
            // due date falls due on its invoice date (see dueDateOf).
            const due = dueDateOf(row);
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
function buildReceivablesRows(invoices, receipts, now, partyKey = 'customer_id') {
    const today = asDate(now instanceof Date ? now : new Date());

    const receivedBy = new Map();
    for (const r of receipts || []) {
        const key = String(r[partyKey]);
        receivedBy.set(key, (receivedBy.get(key) || 0) + Number(r.amount || 0));
    }

    const byCustomer = new Map();
    for (const v of invoices || []) {
        const key = String(v[partyKey]);
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

/**
 * PARTY-WISE receivables — one row per customer, the way the Receivables
 * screen lists them (LiveKeeping parity).
 *
 * Built on the SAME FIFO walk as buildReceivablesRows(), so a party's
 * `outstanding` is exactly the sum of that party's open bills and the page
 * total always equals the dashboard's Total Receivables.
 *
 * Two derived columns need explaining:
 *
 *   credit_days   The credit period the party actually gets, read off the
 *                 bills themselves as the MEDIAN of (due_date - invoice_date).
 *                 The median rather than the mean so one odd bill with a
 *                 far-out due date cannot drag the whole party's terms.
 *                 null when no bill carries a due date.
 *
 *   avg_pay_days  How long this party takes to pay, in days. Receipts are
 *                 allocated to bills oldest-first (the same convention the
 *                 rest of this file uses, because a receipt records a PARTY
 *                 not a bill), and each settled rupee is weighted by how
 *                 long it took. Weighting by amount rather than by bill
 *                 count stops a stack of tiny fast-paid bills from hiding a
 *                 large slow one. null when nothing has been settled.
 *
 * PURE — no db access.
 *
 * The same walk serves PAYABLES: pass the purchase bills, the payment
 * vouchers and partyKey 'supplier_id'. Money owed to a supplier ages exactly
 * the way money owed by a customer does, so the two screens share this rather
 * than growing a near-identical second copy that can drift.
 *
 * @param {Array} invoices  every OPEN bill, already scoped
 * @param {Array<{amount, payment_date}>} receipts  settlement vouchers
 * @param {Date} now
 * @param {string} [partyKey='customer_id']  'customer_id' | 'supplier_id'
 * @returns {Array<{party_id, outstanding, overdue, oldest_age_days,
 *                  bills, credit_days, avg_pay_days}>}
 */
function buildReceivablesParties(invoices, receipts, now, partyKey = 'customer_id') {
    const today = asDate(now instanceof Date ? now : new Date());

    // Receipts per customer: the running total (for FIFO settlement) and the
    // dated list (for avg_pay_days).
    const receivedBy = new Map();
    const receiptsBy = new Map();
    for (const r of receipts || []) {
        const key = String(r[partyKey]);
        receivedBy.set(key, (receivedBy.get(key) || 0) + Number(r.amount || 0));
        if (!receiptsBy.has(key)) receiptsBy.set(key, []);
        receiptsBy.get(key).push({ date: asDate(r.payment_date), amount: Number(r.amount || 0) });
    }

    const byCustomer = new Map();
    for (const v of invoices || []) {
        const key = String(v[partyKey]);
        if (!byCustomer.has(key)) byCustomer.set(key, []);
        byCustomer.get(key).push(v);
    }

    const out = [];
    for (const [key, list] of byCustomer.entries()) {
        const settled = allocateFifo(list, receivedBy.get(key) || 0);

        let outstanding = 0;
        let overdue = 0;
        let oldest = 0;
        let bills = 0;
        const creditDays = [];

        for (const row of settled) {
            const issued = asDate(row.invoice_date);
            // credit_days reports only STATED terms — a synthesised due date
            // (see dueDateOf) is not evidence the party was granted credit.
            const stated = asDate(row.due_date);
            if (issued && stated) creditDays.push(daysBetween(issued, stated));

            const open = row.outstanding;
            if (open <= 0) continue;
            outstanding += open;
            bills += 1;
            if (issued) oldest = Math.max(oldest, Math.max(0, daysBetween(issued, today)));
            const due = dueDateOf(row);
            if (due && daysBetween(today, due) < 0) overdue += open;
        }

        if (outstanding <= 0) continue;

        out.push({
            // `party_id` is the generic name; `customer_id` is kept so the
            // Receivables callers that already read it keep working.
            party_id: list[0][partyKey],
            customer_id: list[0][partyKey],
            outstanding,
            overdue,
            oldest_age_days: oldest,
            bills,
            credit_days: creditDays.length ? median(creditDays) : null,
            avg_pay_days: avgPayDays(list, receiptsBy.get(key) || []),
        });
    }
    return out;
}

function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Amount-weighted average settlement time, in days, rounded to 2dp.
 * Walks bills oldest-first and receipts oldest-first, paying each bill down
 * with whatever receipts are still unspent. A receipt dated BEFORE the bill
 * (an advance) contributes 0 days rather than a negative, which would
 * otherwise let advances cancel out genuinely late payments.
 */
function avgPayDays(invoices, receipts) {
    const bills = (invoices || [])
        .map((v) => ({ d: asDate(v.invoice_date), left: Number(v.total || 0) }))
        .filter((b) => b.d && b.left > 0)
        .sort((a, b) => a.d - b.d);
    // Accepts either the pre-parsed { date } shape this file builds internally
    // or a raw receipt row straight from the db ({ payment_date }).
    const pays = (receipts || [])
        .map((r) => ({ d: r.date ? asDate(r.date) : asDate(r.payment_date), left: Number(r.amount || 0) }))
        .filter((p) => p.d && p.left > 0)
        .sort((a, b) => a.d - b.d);
    if (!bills.length || !pays.length) return null;

    let weighted = 0;
    let paid = 0;
    let bi = 0;
    let pi = 0;
    while (bi < bills.length && pi < pays.length) {
        const take = Math.min(bills[bi].left, pays[pi].left);
        const days = Math.max(0, daysBetween(bills[bi].d, pays[pi].d));
        weighted += take * days;
        paid += take;
        bills[bi].left -= take;
        pays[pi].left -= take;
        if (bills[bi].left <= 0) bi += 1;
        if (pays[pi].left <= 0) pi += 1;
    }
    if (paid <= 0) return null;
    return Math.round((weighted / paid) * 100) / 100;
}

module.exports = {
    BUCKETS, bucketIndexForDays, allocateFifo, buildReceivables, buildReceivablesRows,
    buildReceivablesParties, avgPayDays,
};
