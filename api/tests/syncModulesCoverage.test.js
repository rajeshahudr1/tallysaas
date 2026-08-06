const test = require('node:test');
const assert = require('node:assert');
const SM = require('../Helpers/syncModules');

const NEW_KEYS = ['quotations', 'sales-orders', 'purchase-orders', 'delivery-notes',
                  'receipt-notes', 'credit-notes', 'debit-notes', 'contra',
                  'stock-journal', 'physical-stock'];

test('every new voucher module can be switched on and off', () => {
    const keys = SM.SYNC_MODULES.map((m) => m.key);
    for (const k of NEW_KEYS) assert.ok(keys.includes(k), `no toggle for ${k}`);
});

test('every module has a label a human can read', () => {
    for (const m of SM.SYNC_MODULES) {
        assert.ok(m.label && m.label.trim().length > 1, `bad label for ${m.key}`);
    }
});

test('the five original modules are untouched', () => {
    const keys = SM.SYNC_MODULES.map((m) => m.key);
    for (const k of ['sales-invoices', 'purchase-invoices', 'payments', 'receipts', 'journals']) {
        assert.ok(keys.includes(k), `lost the existing toggle for ${k}`);
    }
});

test('a licence that never configured a selection still gets everything', () => {
    // null/खाली का मतलब आज "सब कुछ" है — नई keys जोड़ने से वो न बदले।
    assert.strictEqual(SM.parseModules(null), null);
    assert.strictEqual(SM.parseModules(''), null);
    assert.strictEqual(SM.isEnabled(null, 'quotations'), true);
});

test('a licence with an explicit selection does not silently gain the new modules', () => {
    const sel = SM.parseModules(JSON.stringify(['sales-invoices']));
    assert.strictEqual(SM.isEnabled(sel, 'sales-invoices'), true);
    assert.strictEqual(SM.isEnabled(sel, 'quotations'), false);
});
