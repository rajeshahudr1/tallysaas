const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'db', 'migrations_tenant', '20260805140000_customer_party_fields.js');

test('the migration adds every missing party field', () => {
    assert.ok(fs.existsSync(MIG), 'migration file missing');
    const src = fs.readFileSync(MIG, 'utf8');
    for (const col of ['ledger_group', 'opening_balance_type', 'country', 'state',
                       'pincode', 'gst_registration_type']) {
        assert.ok(src.includes(`'${col}'`), `column ${col} not declared`);
    }
    const m = require(MIG);
    assert.strictEqual(typeof m.up, 'function');
    assert.strictEqual(typeof m.down, 'function');
});

test('the GST state list is complete and well formed', () => {
    const { GST_STATES } = require('../config/gstStates');
    assert.ok(Array.isArray(GST_STATES));
    // 28 राज्य + 8 केंद्रशासित प्रदेश
    assert.ok(GST_STATES.length >= 36, `expected >=36 entries, got ${GST_STATES.length}`);
    for (const s of GST_STATES) {
        assert.match(s.code, /^\d{2}$/, `bad code for ${s.name}`);
        assert.ok(s.name && s.name.length > 1);
    }
    const codes = GST_STATES.map((s) => s.code);
    assert.strictEqual(new Set(codes).size, codes.length, 'duplicate state code');
    assert.ok(GST_STATES.some((s) => s.name === 'Gujarat' && s.code === '24'));
});

test('the GST registration types match the agreed list exactly', () => {
    const { GST_REGISTRATION_TYPES } = require('../config/gstStates');
    assert.deepStrictEqual(GST_REGISTRATION_TYPES, [
        'Unknown', 'Composition', 'Unregistered/Consumer', 'Government Entity / TDS',
        'Regular - SEZ', 'Regular - Deemed Exporter', 'Regular - Exports (EOU)',
        'e-Commerce Operator', 'Input Service Distributor', 'Embassy/UN Body',
        'Non-Resident Taxpayer', 'Regular',
    ]);
});

// A customer's `state` is only checked against the GST state allow-list when
// country is India (the GST codes drive the CGST/SGST-vs-IGST split and are
// meaningless elsewhere) — see api/Validators/customer.js. Any other country
// must accept free-text state, or saving a non-Indian customer fails outright.
test('customer validator restricts state to the GST list only for India', () => {
    const { createCustomerSchema } = require('../Validators/customer');

    const india = createCustomerSchema.validate({ name: 'A', country: 'India', state: 'Gujarat' });
    assert.strictEqual(india.error, undefined, 'India + a real GST state should pass');

    const indiaBad = createCustomerSchema.validate({ name: 'A', country: 'India', state: 'California' });
    assert.ok(indiaBad.error, 'India + a non-GST state should be rejected');

    const other = createCustomerSchema.validate({ name: 'A', country: 'United States', state: 'California' });
    assert.strictEqual(other.error, undefined, 'a non-India country should accept free-text state');
});
