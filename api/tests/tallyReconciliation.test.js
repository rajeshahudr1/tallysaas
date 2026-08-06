'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    reconcileLedgers, reconcileVouchers, reconcileTrialBalance,
} = require('../Helpers/tallyReconciliation');

// Tally's sign convention: a DEBIT posts is_debit=true with a NEGATIVE amount,
// and opening/closing balances are stored INVERTED too (a Dr balance is stored
// negative). `stored` expresses a debit-positive figure the way Tally saves it,
// so these fixtures match what actually sits in tally_ledgers.
const stored = (accountingValue) => -accountingValue;
const dr = (guid, ledger, amount, extra = {}) => ({
    voucher_guid: guid, ledger_name: ledger, amount: -Math.abs(amount), is_debit: true, ...extra,
});
const cr = (guid, ledger, amount, extra = {}) => ({
    voucher_guid: guid, ledger_name: ledger, amount: Math.abs(amount), is_debit: false, ...extra,
});

test('a complete, correct mirror reconciles clean', () => {
    const ledgers = [
        { name: 'Acme', opening_balance: stored(0), closing_balance: stored(10000) },
        { name: 'Sales', opening_balance: stored(0), closing_balance: stored(-10000) },
    ];
    const entries = [dr('V1', 'Acme', 10000), cr('V1', 'Sales', 10000)];

    const out = reconcileLedgers(ledgers, entries);
    assert.equal(out.ok, true);
    assert.equal(out.checked, 2);
    assert.equal(out.mismatched, 0);
});

test('opening balances are carried into the derived closing', () => {
    const ledgers = [{ name: 'Acme', opening_balance: stored(5000), closing_balance: stored(15000) }];
    const out = reconcileLedgers(ledgers, [dr('V1', 'Acme', 10000)]);
    assert.equal(out.ok, true);
});

test('a dropped voucher is caught and named', () => {
    // Tally says 10000, but only 6000 of postings reached the cloud.
    const ledgers = [{ name: 'Acme', opening_balance: stored(0), closing_balance: stored(10000) }];
    const out = reconcileLedgers(ledgers, [dr('V1', 'Acme', 6000)]);

    assert.equal(out.ok, false);
    assert.equal(out.mismatched, 1);
    assert.equal(out.mismatches[0].ledger, 'Acme');
    assert.equal(out.mismatches[0].reported, 10000);
    assert.equal(out.mismatches[0].derived, 6000);
    assert.equal(out.mismatches[0].difference, -4000);
});

test('mismatches are ordered biggest-problem-first', () => {
    const ledgers = [
        { name: 'Small', opening_balance: stored(0), closing_balance: stored(100) },
        { name: 'Big',   opening_balance: stored(0), closing_balance: stored(90000) },
    ];
    const out = reconcileLedgers(ledgers, []);
    assert.equal(out.mismatches[0].ledger, 'Big');
    assert.equal(out.total_difference, 90100);
});

test('postings naming a ledger with no master are reported separately', () => {
    // A real defect: the ledger master was missed, or renamed after its
    // vouchers synced, so its balance appears in no report at all.
    const out = reconcileLedgers(
        [{ name: 'Acme', opening_balance: stored(0), closing_balance: stored(10000) }],
        [dr('V1', 'Acme', 10000), cr('V1', 'Ghost Ledger', 10000)],
    );
    assert.equal(out.ok, false);
    assert.equal(out.mismatched, 0, 'the known ledger itself is fine');
    assert.deepEqual(out.unknown_ledgers, [{ ledger: 'Ghost Ledger', movement: -10000 }]);
});

test('float noise from many postings is not reported as a gap', () => {
    const entries = Array.from({ length: 300 }, () => dr('V1', 'Acme', 0.1));
    const out = reconcileLedgers(
        [{ name: 'Acme', opening_balance: stored(0), closing_balance: stored(30) }], entries);
    assert.equal(out.ok, true);
});

test('a balanced voucher passes the double-entry check', () => {
    const out = reconcileVouchers([dr('V1', 'Acme', 11800), cr('V1', 'Sales', 10000),
                                   cr('V1', 'CGST', 900), cr('V1', 'SGST', 900)]);
    assert.equal(out.ok, true);
    assert.equal(out.checked, 1);
});

test('a voucher missing a leg is caught even though each leg imported fine', () => {
    // The GST legs never made it: nothing errored, but the Trial Balance will
    // not tie and no single import step is at fault.
    const out = reconcileVouchers([dr('V1', 'Acme', 11800), cr('V1', 'Sales', 10000)]);
    assert.equal(out.ok, false);
    // Debit-positive net: +11800 - 10000 = +1800, i.e. 1800 of CREDIT is missing.
    assert.equal(out.vouchers[0].difference, 1800);
    assert.equal(out.vouchers[0].reason, 'debits do not equal credits');
});

test('a single-leg voucher is reported as a missing counter-leg, not an amount gap', () => {
    const out = reconcileVouchers([dr('V1', 'Acme', 500)]);
    assert.equal(out.ok, false);
    assert.equal(out.vouchers[0].legs, 1);
    assert.match(out.vouchers[0].reason, /counter-leg/);
});

test('the trial balance identity holds when debits equal credits', () => {
    const out = reconcileTrialBalance([dr('V1', 'Acme', 11800), cr('V1', 'Sales', 10000),
                                       cr('V1', 'CGST', 900), cr('V1', 'SGST', 900)]);
    assert.equal(out.ok, true);
    assert.equal(out.debit_total, 11800);
    assert.equal(out.credit_total, 11800);
    assert.equal(out.difference, 0);
});

test('the trial balance identity fails loudly when the book is short a credit', () => {
    const out = reconcileTrialBalance([dr('V1', 'Acme', 11800), cr('V1', 'Sales', 10000)]);
    assert.equal(out.ok, false);
    assert.equal(out.difference, 1800);
});

const { compareVoucherTypes } = require('../Helpers/tallyReconciliation');

test('a voucher type defined in Tally with nothing synced is listed', () => {
    const out = compareVoucherTypes(
        [{ name: 'Sales', is_active: true }, { name: 'Sales Order', is_active: true }],
        [{ voucher_type: 'Sales', vouchers: 1241 }],
    );
    assert.equal(out.ok, false);
    assert.equal(out.missing.length, 1);
    assert.equal(out.missing[0].name, 'Sales Order');
});

test('a deactivated type with nothing synced is not flagged', () => {
    const out = compareVoucherTypes(
        [{ name: 'Sales', is_active: true }, { name: 'Old Type', is_active: false }],
        [{ voucher_type: 'Sales', vouchers: 10 }],
    );
    assert.equal(out.ok, true);
});

test('vouchers whose TYPE master never synced are reported', () => {
    // The reverse gap: the voucher-type pull missed a type the vouchers use.
    const out = compareVoucherTypes(
        [{ name: 'Sales', is_active: true }],
        [{ voucher_type: 'Sales', vouchers: 10 }, { voucher_type: 'RETAIL CASH SALES', vouchers: 1264 }],
    );
    assert.equal(out.ok, false);
    assert.equal(out.synced_only[0].name, 'retail cash sales');
    assert.equal(out.synced_only[0].synced, 1264);
});

test('type matching ignores case', () => {
    const out = compareVoucherTypes(
        [{ name: 'Retail Cash Sales', is_active: true }],
        [{ voucher_type: 'RETAIL CASH SALES', vouchers: 5 }],
    );
    assert.equal(out.ok, true);
    assert.equal(out.types[0].synced, 5);
});
