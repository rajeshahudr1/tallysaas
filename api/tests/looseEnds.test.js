const test = require('node:test');
const assert = require('node:assert');
const { outstandingOnly } = require('../Controllers/Tenant/CollectPaymentController');

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
