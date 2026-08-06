const test = require('node:test');
const assert = require('node:assert');
const { outstandingOnly } = require('../Controllers/Tenant/CollectPaymentController');
const {
    BUCKETS, bucketIndexForDays, buildReceivables, buildReceivablesRows,
} = require('../Helpers/receivablesAgeing');

test('a fully paid bill is not offered for collection', () => {
    const rows = outstandingOnly([{ id: 1, total: 100, paid: 100 }]);
    assert.deepStrictEqual(rows, []);
});

test('a partly paid bill is offered, with what is still due', () => {
    const rows = outstandingOnly([{ id: 1, total: 100, paid: 40 }]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].outstanding), 60);
});

test('an unpaid bill is offered in full', () => {
    const rows = outstandingOnly([{ id: 1, total: 100, paid: 0 }]);
    assert.strictEqual(Number(rows[0].outstanding), 100);
});

test('an overpaid bill is not offered and never shows a negative due', () => {
    assert.deepStrictEqual(outstandingOnly([{ id: 1, total: 100, paid: 130 }]), []);
});

test('a missing paid figure is treated as nothing paid, not as an error', () => {
    const rows = outstandingOnly([{ id: 1, total: 50 }]);
    assert.strictEqual(Number(rows[0].outstanding), 50);
});

/* ── Task 2: dashboard ageing buckets → receivables drill-down ──────────
 * The dashboard's bucket totals and the drill-down list MUST agree — both
 * have to walk the exact same boundaries, from Helpers/receivablesAgeing.js,
 * or one of them is lying about the customer's money. */

test('a bill lands in exactly one ageing bucket', () => {
    // Every age from 0 to well past the last boundary maps to exactly one
    // index into BUCKETS — the easiest place for an off-by-one to hide two
    // amounts in the dashboard doughnut (or none at all).
    for (let days = 0; days <= 400; days += 1) {
        const idx = bucketIndexForDays(days);
        assert.ok(idx >= 0 && idx < BUCKETS.length,
            `day ${days} must resolve to a real bucket index, got ${idx}`);
    }
});

test('the bucket boundaries match the ones the dashboard shows', () => {
    assert.deepStrictEqual(BUCKETS.map((b) => b.label), [
        '0 - 45 Days', '45 - 90 Days', '90 - 135 Days',
        '135 - 180 Days', '180 - 225 Days', '> 225 Days',
    ]);
    // A boundary day belongs to the LOWER band.
    assert.strictEqual(bucketIndexForDays(45), 0);
    assert.strictEqual(bucketIndexForDays(46), 1);
    assert.strictEqual(bucketIndexForDays(90), 1);
    assert.strictEqual(bucketIndexForDays(91), 2);
    assert.strictEqual(bucketIndexForDays(225), 4);
    assert.strictEqual(bucketIndexForDays(226), 5);
    assert.strictEqual(bucketIndexForDays(10000), 5);
});

test('buildReceivablesRows filtered to one bucket sums to the same amount buildReceivables put there', () => {
    const now = new Date(2026, 7, 6); // 2026-08-06, matches "today"
    const invoices = [
        { customer_id: 1, invoice_date: '2026-08-01', due_date: '2026-08-15', total: 1000 }, // 5 days old
        { customer_id: 1, invoice_date: '2026-05-01', due_date: '2026-05-15', total: 500 },   // 97 days old → 90-135 band
        { customer_id: 2, invoice_date: '2025-11-01', due_date: '2025-11-15', total: 700 },   // 278 days old
    ];
    const receipts = []; // nothing settled, so every invoice is fully open

    const rolled = buildReceivables(invoices, receipts, now);
    const rows = buildReceivablesRows(invoices, receipts, now);

    // Every row's own bucket_index must match its bucket_label, and re-summing
    // the rows into buckets must reproduce buildReceivables()'s own totals —
    // this is the guarantee the dashboard total and the drill-down rely on.
    for (const r of rows) {
        assert.strictEqual(r.bucket_label, BUCKETS[r.bucket_index].label);
    }
    for (let i = 0; i < BUCKETS.length; i += 1) {
        const sumForBucket = rows
            .filter((r) => r.bucket_index === i)
            .reduce((s, r) => s + r.outstanding, 0);
        assert.strictEqual(sumForBucket, rolled.buckets[i].amount,
            `bucket ${i} (${BUCKETS[i].label}) must match between the rolled-up total and the row-level sum`);
    }

    // Sanity: the three invoices land in three different buckets given the ages above.
    const idxByCustomerTotal = rows.map((r) => r.bucket_index).sort();
    assert.deepStrictEqual(idxByCustomerTotal, [0, 2, 5]);
});
