const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// quotation.js को बिना DOM के चलाओ — सिर्फ़ गणित वाले हिस्से की जाँच।
function loadCalc() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'quotation.js'), 'utf8');
    const sandbox = { window: {}, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.QuotationCalc;
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
    // Sub Total is the TAXABLE value — 250 gross less 20 discount.
    assert.strictEqual(t.gross, 250);
    assert.strictEqual(t.discount, 20);
    assert.strictEqual(t.subtotal, 230);
    assert.strictEqual(t.taxes, 32.4);
    assert.strictEqual(t.grand, 262.4);
});

test('the totals panel reconciles: subtotal + taxes = grand', () => {
    const { formTotals } = loadCalc();
    // The two shapes that used to break the display: a discounted bill, and a
    // tax-inclusive rate (whose GST was counted twice on screen).
    const cases = [
        [{ qty: 2, rate: 100, disc: 10, gst: 18 }, { qty: 1, rate: 50, disc: 0, gst: 0 }],
        [{ qty: 1, rate: 749, disc: 0, gst: 6 }],
        [{ qty: 3, rate: 33.33, disc: 7.5, gst: 12 }],
        [{ qty: 1, rate: 118, disc: 0, gst: 18, taxIncl: true }],
        [{ qty: 2, rate: 118, disc: 10, gst: 18, taxIncl: true }],
    ];
    for (const lines of cases) {
        const t = formTotals(lines);
        const shown = Math.round((t.subtotal + t.taxes + Number.EPSILON) * 100) / 100;
        assert.strictEqual(shown, t.grand,
            `panel must add up for ${JSON.stringify(lines)}`);
        // …and the gross must always account for itself too.
        const net = Math.round((t.gross - t.discount + Number.EPSILON) * 100) / 100;
        assert.ok(net >= t.subtotal - 0.01,
            'taxable can never exceed gross less discount');
    }
});

test('a tax-inclusive line does not double-count its GST in the total', () => {
    const { formTotals } = loadCalc();
    // ₹118 quoted inclusive of 18% is ₹100 + ₹18 — the customer still pays 118.
    const t = formTotals([{ qty: 1, rate: 118, disc: 0, gst: 18, taxIncl: true }]);
    assert.strictEqual(t.grand, 118);
    assert.strictEqual(t.taxes, 18);
});

test('buildVoucherNo joins prefix, number and suffix as typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: 'df', number: '3', suffix: 'fd' }), 'df3fd');
});

test('buildVoucherNo trims the parts and skips the empty ones', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: ' QT/ ', number: '007', suffix: '' }), 'QT/007');
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '12', suffix: '' }), '12');
});

test('buildVoucherNo returns an empty string when nothing was typed', () => {
    const { buildVoucherNo } = loadCalc();
    assert.strictEqual(buildVoucherNo({ prefix: '', number: '', suffix: '' }), '');
});

/* ── Price level ─────────────────────────────────────────────────
 * What a price level DOES: it decides which rate fills the Rate column when
 * an item is picked, instead of the item's own standard price. Tally lets a
 * level band that rate by quantity, so the band that applies is the part
 * worth pinning down.
 */

test('slabRate picks the band the quantity falls in', () => {
    const { slabRate } = loadCalc();
    const slabs = [
        { from_qty: 1,   to_qty: 99,   rate: 100 },
        { from_qty: 100, to_qty: 499,  rate: 90 },
        { from_qty: 500, to_qty: null, rate: 80 },
    ];
    assert.strictEqual(slabRate(slabs, 1).rate, 100);
    assert.strictEqual(slabRate(slabs, 99).rate, 100);
    assert.strictEqual(slabRate(slabs, 100).rate, 90);
    assert.strictEqual(slabRate(slabs, 499).rate, 90);
    // The last band is open-ended — 500 and 50,000 both land on it.
    assert.strictEqual(slabRate(slabs, 500).rate, 80);
    assert.strictEqual(slabRate(slabs, 50000).rate, 80);
});

test('an un-banded level applies before any quantity is typed', () => {
    const { slabRate } = loadCalc();
    // The common case: one rate, no bands. Qty is still 0 while the user is
    // picking the item, and the rate must land anyway.
    const slabs = [{ from_qty: null, to_qty: null, rate: 250 }];
    assert.strictEqual(slabRate(slabs, 0).rate, 250);
    assert.strictEqual(slabRate(slabs, 7).rate, 250);
});

test('a quantity below every band still gets a rate, not nothing', () => {
    const { slabRate } = loadCalc();
    // Bands starting at 10 with qty 0 (nothing typed yet): falling through to
    // "no rate" would leave the line at 0.00 and look like a free item.
    const slabs = [{ from_qty: 10, to_qty: 99, rate: 40 }];
    assert.strictEqual(slabRate(slabs, 0).rate, 40);
});

test('slabRate says nothing when the level does not cover the item', () => {
    const { slabRate } = loadCalc();
    // null means "this level has no opinion" — the caller then uses the item's
    // own price rather than pricing it at zero.
    assert.strictEqual(slabRate([], 5), null);
    assert.strictEqual(slabRate(null, 5), null);
    assert.strictEqual(slabRate(undefined, 5), null);
});
