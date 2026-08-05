const test = require('node:test');
const assert = require('node:assert');
const { computeTotals } = require('../Controllers/Tenant/DeliveryNoteController');

test('computeTotals ignores client-sent totals and derives its own', () => {
    const r = computeTotals([
        { quantity: 2, rate: 100, discount_pct: 10, gst_rate: 18, total: 99999 },
    ]);
    assert.strictEqual(Number(r.subtotal), 200);
    assert.strictEqual(Number(r.discount), 20);
    assert.strictEqual(Number(r.taxable), 180);
    assert.strictEqual(Number(r.tax_amount), 32.4);
    assert.strictEqual(Number(r.total), 212.4);
});

test('computeTotals treats a tax-inclusive line as rate-includes-GST', () => {
    const r = computeTotals([
        { quantity: 1, rate: 118, discount_pct: 0, gst_rate: 18, tax_inclusive: true },
    ]);
    assert.strictEqual(Number(r.taxable), 100);
    assert.strictEqual(Number(r.tax_amount), 18);
    assert.strictEqual(Number(r.total), 118);
});

test('computeTotals handles an empty item list without throwing', () => {
    assert.strictEqual(Number(computeTotals([]).total), 0);
});
