const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'db', 'migrations_tenant', '20260806040000_stock_vouchers.js');

test('the migration exists and exports up/down', () => {
    assert.ok(fs.existsSync(MIG), 'migration file missing');
    const m = require(MIG);
    assert.strictEqual(typeof m.up, 'function');
    assert.strictEqual(typeof m.down, 'function');
});

test('it declares the stock-journal columns and the adjustment voucher tags', () => {
    const src = fs.readFileSync(MIG, 'utf8');
    for (const col of ['voucher_no', 'journal_date', 'direction', 'godown',
                       'quantity', 'voucher_kind', 'tally_voucher_type']) {
        assert.ok(src.includes(`'${col}'`), `column ${col} not declared`);
    }
});

test('a stock journal must balance: source quantity equals destination quantity', () => {
    const { isBalanced } = require('../Controllers/Tenant/StockJournalController');
    assert.strictEqual(isBalanced([
        { direction: 'source', quantity: 5 },
        { direction: 'destination', quantity: 5 },
    ]), true);
    assert.strictEqual(isBalanced([
        { direction: 'source', quantity: 5 },
        { direction: 'destination', quantity: 4 },
    ]), false);
    // कोई destination न हो = खपत (consumption) — यह भी मान्य है
    assert.strictEqual(isBalanced([{ direction: 'source', quantity: 5 }]), true);
    // सिर्फ़ destination = कहीं से नहीं आया माल — यह मान्य नहीं
    assert.strictEqual(isBalanced([{ direction: 'destination', quantity: 5 }]), false);
});

test('a physical stock sheet never sets a negative count', () => {
    const { normaliseCounts } = require('../Controllers/Tenant/PhysicalStockController');
    const rows = normaliseCounts([
        { product_id: 1, counted_qty: 7 },
        { product_id: 2, counted_qty: -3 },
    ]);
    assert.strictEqual(rows[0].counted_qty, 7);
    assert.strictEqual(rows[1].counted_qty, 0);
});
