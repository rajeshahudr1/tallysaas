'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    BUCKETS, bucketIndexForDays, allocateFifo, buildReceivables,
} = require('../Helpers/receivablesAgeing');

const TODAY = new Date(2026, 7, 3);        // 3 Aug 2026

// Helper: an invoice N days before TODAY, due D days after issue.
function inv(customerId, id, ageDays, total, dueInDays) {
    const d = new Date(2026, 7, 3 - ageDays);
    const due = new Date(2026, 7, 3 - ageDays + (dueInDays == null ? 30 : dueInDays));
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return { id, customer_id: customerId, invoice_date: iso(d), due_date: iso(due), total };
}

test('the six buckets match the reference ageing bands', () => {
    assert.deepStrictEqual(BUCKETS.map((b) => b.label), [
        '0 - 45 Days', '45 - 90 Days', '90 - 135 Days',
        '135 - 180 Days', '180 - 225 Days', '> 225 Days',
    ]);
});

test('bucketIndexForDays puts a boundary day in the LOWER bucket', () => {
    assert.strictEqual(bucketIndexForDays(0), 0);
    assert.strictEqual(bucketIndexForDays(45), 0);
    assert.strictEqual(bucketIndexForDays(46), 1);
    assert.strictEqual(bucketIndexForDays(90), 1);
    assert.strictEqual(bucketIndexForDays(91), 2);
    assert.strictEqual(bucketIndexForDays(225), 4);
    assert.strictEqual(bucketIndexForDays(226), 5);
    assert.strictEqual(bucketIndexForDays(9999), 5);
});

test('allocateFifo clears the oldest invoices first', () => {
    const invoices = [inv(1, 10, 200, 1000), inv(1, 11, 100, 1000), inv(1, 12, 10, 1000)];
    const out = allocateFifo(invoices, 1500);
    assert.deepStrictEqual(out.map((o) => o.outstanding), [0, 500, 1000]);
});

test('allocateFifo leaves everything outstanding when nothing was received', () => {
    const invoices = [inv(1, 10, 200, 1000), inv(1, 11, 10, 500)];
    assert.deepStrictEqual(allocateFifo(invoices, 0).map((o) => o.outstanding), [1000, 500]);
});

test('allocateFifo never goes negative when receipts exceed billing', () => {
    const invoices = [inv(1, 10, 50, 400)];
    assert.deepStrictEqual(allocateFifo(invoices, 10000).map((o) => o.outstanding), [0]);
});

test('buildReceivables buckets each customer independently', () => {
    const invoices = [
        inv(1, 10, 200, 1000),   // customer 1, oldest — cleared by the receipt
        inv(1, 11, 10, 1000),    // customer 1, recent — stays outstanding
        inv(2, 20, 120, 5000),   // customer 2, no receipts at all
    ];
    const receipts = [{ customer_id: 1, amount: 1000 }];
    const out = buildReceivables(invoices, receipts, TODAY);

    assert.strictEqual(out.total, 6000);
    assert.strictEqual(out.buckets[0].amount, 1000);   // 0-45   → invoice 11
    assert.strictEqual(out.buckets[2].amount, 5000);   // 90-135 → invoice 20
    assert.strictEqual(out.buckets[5].amount, 0);
});

test('buildReceivables sums receipts per customer before allocating', () => {
    const invoices = [inv(1, 10, 10, 1000)];
    const receipts = [{ customer_id: 1, amount: 400 }, { customer_id: 1, amount: 250 }];
    const out = buildReceivables(invoices, receipts, TODAY);
    assert.strictEqual(out.total, 350);
});

test('overdue counts only invoices whose due date has passed', () => {
    const invoices = [
        inv(1, 10, 90, 1000, 30),    // issued 90d ago, due 60d ago → overdue
        inv(1, 11, 5,  2000, 30),    // due in 25 days → not overdue
    ];
    const out = buildReceivables(invoices, [], TODAY);
    assert.strictEqual(out.overdue, 1000);
});

test('projections cover invoices falling due within 15 and 60 days', () => {
    const invoices = [
        inv(1, 10, 0, 1000, 10),     // due in 10 days → both windows
        inv(1, 11, 0, 2000, 40),     // due in 40 days → 60-day window only
        inv(1, 12, 0, 4000, 90),     // due in 90 days → neither
        inv(1, 13, 90, 8000, 30),    // already overdue → neither projection
    ];
    const out = buildReceivables(invoices, [], TODAY);
    assert.strictEqual(out.projection_15, 1000);
    assert.strictEqual(out.projection_60, 3000);
});

test('a fully settled customer contributes nothing', () => {
    const out = buildReceivables([inv(1, 10, 30, 900)], [{ customer_id: 1, amount: 900 }], TODAY);
    assert.strictEqual(out.total, 0);
    assert.strictEqual(out.overdue, 0);
    assert.deepStrictEqual(out.buckets.map((b) => b.amount), [0, 0, 0, 0, 0, 0]);
});

test('empty input yields a zeroed structure, not a crash', () => {
    const out = buildReceivables([], [], TODAY);
    assert.strictEqual(out.total, 0);
    assert.strictEqual(out.buckets.length, 6);
});

test('an invoice with no due date is never overdue and never projected', () => {
    const one = inv(1, 10, 300, 1000);
    one.due_date = null;
    const out = buildReceivables([one], [], TODAY);
    assert.strictEqual(out.total, 1000);
    assert.strictEqual(out.overdue, 0);
    assert.strictEqual(out.projection_60, 0);
});
