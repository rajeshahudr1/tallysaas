const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// receipt-note.js को बिना DOM के चलाओ — सिर्फ़ गणित वाले हिस्से की जाँच।
function loadCalc() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'receipt-note.js'), 'utf8');
    const sandbox = { window: {}, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.ReceiptNoteCalc;
}

test('lineAmount applies discount then GST', () => {
    const { lineAmount } = loadCalc();
    assert.strictEqual(lineAmount({ qty: 2, rate: 100, disc: 10, gst: 18 }), 212.4);
});

test('lineAmount treats a tax-inclusive rate as GST-included', () => {
    const { lineAmount } = loadCalc();
    assert.strictEqual(lineAmount({ qty: 1, rate: 118, disc: 0, gst: 18, taxIncl: true }), 118);
});

test('formTotals adds every line up', () => {
    const { formTotals } = loadCalc();
    const t = formTotals([
        { qty: 2, rate: 100, disc: 10, gst: 18 },
        { qty: 1, rate: 50, disc: 0, gst: 0 },
    ]);
    assert.strictEqual(t.subtotal, 250);
    assert.strictEqual(t.taxes, 32.4);
    assert.strictEqual(t.grand, 262.4);
});

test('buildVoucherNo joins prefix, number and suffix as typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: 'df', number: '3', suffix: 'fd' }), 'df3fd');
});

test('buildVoucherNo trims the parts and skips the empty ones', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: ' RN/ ', number: '007', suffix: '' }), 'RN/007');
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '12', suffix: '' }), '12');
});

test('buildVoucherNo returns an empty string when nothing was typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '', suffix: '' }), '');
});
