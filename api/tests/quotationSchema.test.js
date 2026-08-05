const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const MIG = path.join(__dirname, '..', 'db', 'migrations_tenant', '20260805100000_quotations.js');

test('the quotations migration exists and exports up/down', () => {
    assert.ok(fs.existsSync(MIG), 'migration file missing');
    const m = require(MIG);
    assert.strictEqual(typeof m.up, 'function');
    assert.strictEqual(typeof m.down, 'function');
});

test('the migration declares every column the module needs', () => {
    const src = fs.readFileSync(MIG, 'utf8');
    for (const col of ['quotation_no', 'quotation_date', 'valid_till', 'ledger_name',
                       'quote_status', 'converted_invoice_id', 'tally_voucher_type',
                       'tally_optional', 'godown', 'tax_inclusive']) {
        assert.ok(src.includes(`'${col}'`), `column ${col} not declared`);
    }
});
