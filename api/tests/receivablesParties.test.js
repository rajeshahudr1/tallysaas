'use strict';

/**
 * tests/receivablesParties.test.js
 *
 * The party-wise Receivables rollup (Outstanding / Overdue / Credit Days /
 * Avg Pay Days) that the Receivables screen lists. These are the columns a
 * user reads to decide who to chase, so each one is pinned to a worked
 * example rather than to whatever the implementation happens to return.
 *
 * Run: node --test tests/receivablesParties.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildReceivablesParties, buildReceivablesRows, avgPayDays,
} = require('../Helpers/receivablesAgeing');

const NOW = new Date(2026, 7, 8); // 8 Aug 2026, local midnight

test('rolls each customer up to one row, and drops fully-settled parties', () => {
    const invoices = [
        { customer_id: 1, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 1000 },
        { customer_id: 1, invoice_date: '2026-07-01', due_date: '2026-08-01', total: 500 },
        { customer_id: 2, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 800 },
    ];
    // Customer 2 has paid in full, so they leave the list entirely.
    const receipts = [{ customer_id: 2, amount: 800, payment_date: '2026-06-20' }];

    const rows = buildReceivablesParties(invoices, receipts, NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_id, 1);
    assert.equal(rows[0].outstanding, 1500);
    assert.equal(rows[0].bills, 2);
});

test('outstanding ties to the bill-level list, bill for bill', () => {
    const invoices = [
        { customer_id: 1, invoice_date: '2026-05-01', due_date: '2026-06-01', total: 1000 },
        { customer_id: 1, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 700 },
        { customer_id: 2, invoice_date: '2026-04-01', due_date: '2026-05-01', total: 2000 },
    ];
    const receipts = [
        { customer_id: 1, amount: 1200, payment_date: '2026-06-10' },
        { customer_id: 2, amount: 500, payment_date: '2026-05-10' },
    ];

    const parties = buildReceivablesParties(invoices, receipts, NOW);
    const bills = buildReceivablesRows(invoices, receipts, NOW);

    for (const p of parties) {
        const mine = bills
            .filter((b) => String(b.customer_id) === String(p.customer_id))
            .reduce((s, b) => s + b.outstanding, 0);
        assert.equal(p.outstanding, mine, `party ${p.customer_id} must equal its bills`);
    }
    // …and the grand totals agree too.
    assert.equal(
        parties.reduce((s, p) => s + p.outstanding, 0),
        bills.reduce((s, b) => s + b.outstanding, 0),
    );
});

test('overdue counts only bills whose due date has passed', () => {
    const invoices = [
        // due 1 Jul — past, so overdue
        { customer_id: 1, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 1000 },
        // due 1 Sep — still to come, so NOT overdue but still outstanding
        { customer_id: 1, invoice_date: '2026-08-01', due_date: '2026-09-01', total: 400 },
    ];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.outstanding, 1400);
    assert.equal(row.overdue, 1000);
});

test('a bill with no due date falls due on its invoice date', () => {
    // Tally's zero-credit-period behaviour, and what LiveKeeping shows: a
    // party with no agreed terms owes the money now, so an old bill with no
    // due date reads as fully overdue rather than silently not-overdue.
    const invoices = [{ customer_id: 1, invoice_date: '2026-01-01', due_date: null, total: 900 }];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.outstanding, 900);
    assert.equal(row.overdue, 900);
    // …but we still don't claim the party was granted 0 days of credit.
    assert.equal(row.credit_days, null, 'no STATED due date → no credit terms to report');
});

test('a no-due-date bill dated today is not yet overdue', () => {
    const invoices = [{ customer_id: 1, invoice_date: '2026-08-08', due_date: null, total: 900 }];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.outstanding, 900);
    assert.equal(row.overdue, 0, 'due today is not yet past due');
});

test('credit_days is the MEDIAN bill term, so one outlier cannot skew it', () => {
    const invoices = [
        { customer_id: 1, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 100 }, // 30
        { customer_id: 1, invoice_date: '2026-06-02', due_date: '2026-07-02', total: 100 }, // 30
        { customer_id: 1, invoice_date: '2026-06-03', due_date: '2027-06-03', total: 100 }, // 365
    ];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.credit_days, 30);
});

test('oldest_age_days reports the age of the oldest OPEN bill', () => {
    const invoices = [
        { customer_id: 1, invoice_date: '2026-06-08', due_date: '2026-07-08', total: 500 }, // 61 days
        { customer_id: 1, invoice_date: '2026-08-01', due_date: '2026-09-01', total: 500 }, //  7 days
    ];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.oldest_age_days, 61);
});

test('avg_pay_days weights by amount, not by bill count', () => {
    // One big slow bill and one small fast one. A per-bill mean would say
    // (60 + 0) / 2 = 30 days; weighting by rupees says the party is slow.
    const invoices = [
        { customer_id: 1, invoice_date: '2026-01-01', total: 9000 },
        { customer_id: 1, invoice_date: '2026-03-01', total: 1000 },
    ];
    const receipts = [
        { customer_id: 1, amount: 9000, payment_date: '2026-03-02' }, // 60 days after bill 1
        { customer_id: 1, amount: 1000, payment_date: '2026-03-01' }, //  0 days after bill 2
    ];
    const days = avgPayDays(invoices, receipts);
    // (9000 × 60 + 1000 × 0) / 10000 = 54
    assert.equal(days, 54);
});

test('an advance counts as 0 days, never as a negative that offsets late bills', () => {
    const invoices = [
        { customer_id: 1, invoice_date: '2026-03-01', total: 1000 },
        { customer_id: 1, invoice_date: '2026-03-02', total: 1000 },
    ];
    const receipts = [
        { customer_id: 1, amount: 1000, payment_date: '2026-01-01' }, // paid 2 months EARLY
        { customer_id: 1, amount: 1000, payment_date: '2026-04-11' }, // 40 days late
    ];
    const days = avgPayDays(invoices, receipts);
    assert.ok(days >= 0, 'an advance must not push the average below zero');
    // (1000 × 0 + 1000 × 40) / 2000 = 20
    assert.equal(days, 20);
});

test('avg_pay_days is null when the party has never paid', () => {
    const invoices = [{ customer_id: 1, invoice_date: '2026-06-01', due_date: '2026-07-01', total: 500 }];
    const [row] = buildReceivablesParties(invoices, [], NOW);
    assert.equal(row.avg_pay_days, null);
});
