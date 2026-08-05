const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'db', 'migrations_tenant', '20260805220000_delivery_notes.js');

test('the delivery-note migration exists and exports up/down', () => {
    assert.ok(fs.existsSync(MIG), 'migration file missing');
    const m = require(MIG);
    assert.strictEqual(typeof m.up, 'function');
    assert.strictEqual(typeof m.down, 'function');
});

test('it declares every column the module needs', () => {
    const src = fs.readFileSync(MIG, 'utf8');
    for (const col of ['note_no', 'note_date', 'dispatch_date', 'ledger_name', 'delivery_status',
                       'sales_order_id', 'converted_invoice_id', 'tally_voucher_type', 'tally_optional',
                       'godown', 'tax_inclusive']) {
        assert.ok(src.includes(`'${col}'`), `column ${col} not declared`);
    }
});
