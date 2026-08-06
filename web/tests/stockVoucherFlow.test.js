const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// stock-voucher.js को बिना DOM के चलाओ — सिर्फ़ गणित वाले हिस्से की जाँच।
function loadCalc() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stock-voucher.js'), 'utf8');
    const sandbox = { window: {}, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.StockVoucherCalc;
}

test('totalQty adds every row', () => {
    const { totalQty } = loadCalc();
    assert.strictEqual(totalQty([{ qty: 2 }, { qty: 3.5 }, { qty: 0 }]), 5.5);
});

test('totalQty ignores blank and non-numeric rows', () => {
    const { totalQty } = loadCalc();
    assert.strictEqual(totalQty([{ qty: '' }, { qty: 'abc' }, { qty: 4 }]), 4);
});

test('buildVoucherNo joins prefix, number and suffix as typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: 'df', number: '3', suffix: 'fd' }), 'df3fd');
});

test('buildVoucherNo trims the parts and skips the empty ones', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: ' DN/ ', number: '007', suffix: '' }), 'DN/007');
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '12', suffix: '' }), '12');
});

test('buildVoucherNo returns an empty string when nothing was typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '', suffix: '' }), '');
});
