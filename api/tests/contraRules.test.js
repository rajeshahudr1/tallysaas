const test = require('node:test');
const assert = require('node:assert');
const { VCH_TYPES, listJournalSchema } = require('../Validators/journal');

test('Contra is an accepted voucher type', () => {
    assert.ok(VCH_TYPES.includes('Contra'));
});

test('the list schema accepts a vch_type filter', () => {
    const { error, value } = listJournalSchema.validate({ vch_type: 'Contra' });
    assert.strictEqual(error, undefined);
    assert.strictEqual(value.vch_type, 'Contra');
});

test('the list schema rejects a voucher type that is not in the catalogue', () => {
    const { error } = listJournalSchema.validate({ vch_type: 'Nonsense' });
    assert.ok(error, 'an unknown vch_type must be rejected');
});

test('the controller exposes the cash/bank ledger check the Contra rule needs', () => {
    const c = require('../Controllers/Tenant/JournalController');
    assert.strictEqual(typeof c.isCashOrBankLedger, 'function');
});
