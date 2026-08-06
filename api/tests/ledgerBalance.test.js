'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { signed, periodBalance, drCr } = require('../Helpers/ledgerBalance');

// Entries exactly as tally_voucher_entries stores them. Tally's own sign
// convention (see agent/tally_connector.py: "a debit posts ISDEEMEDPOSITIVE=Yes
// AMOUNT=-x, a credit No +x") means a DEBIT arrives as a NEGATIVE amount.
const E = (date, amount, isDebit) => ({ voucher_date: date, amount, is_debit: isDebit });
const DEBIT  = (date, amt) => E(date, -Math.abs(amt), true);
const CREDIT = (date, amt) => E(date,  Math.abs(amt), false);

test('signed() converts Tally signs into debit-positive accounting signs', () => {
    // Tally stores a 500 debit as -500 with is_debit true.
    assert.strictEqual(signed({ amount: -500, is_debit: true }), 500);
    // ...and a 500 credit as +500 with is_debit false.
    assert.strictEqual(signed({ amount: 500, is_debit: false }), -500);
    assert.strictEqual(signed({ amount: '-250.50', is_debit: true }), 250.5);
    assert.strictEqual(signed({ amount: null, is_debit: true }), 0);
});

test('signed() trusts is_debit over the stored sign', () => {
    // A feed that ever sends unsigned amounts must still read correctly.
    assert.strictEqual(signed({ amount: 500, is_debit: true }), 500);
    assert.strictEqual(signed({ amount: -500, is_debit: false }), -500);
});

test('opening carries the ledger opening plus everything before the range', () => {
    const out = periodBalance({
        opening: 1000,
        entries: [DEBIT('2026-03-31', 500), DEBIT('2026-04-05', 200)],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.opening, 1500);   // 1000 + the 31 Mar debit
});

test('closing is opening plus the in-range movement', () => {
    const out = periodBalance({
        opening: 1000,
        entries: [DEBIT('2026-04-05', 200), CREDIT('2026-04-20', 300)],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.opening, 1000);
    assert.strictEqual(out.debit, 200);
    assert.strictEqual(out.credit, 300);
    assert.strictEqual(out.closing, 900);    // 1000 + 200 - 300
});

test('range ends are inclusive on both sides', () => {
    const out = periodBalance({
        opening: 0,
        entries: [DEBIT('2026-04-01', 100), DEBIT('2026-04-30', 50)],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.debit, 150);
});

test('entries after the range affect neither opening nor closing', () => {
    const out = periodBalance({
        opening: 0,
        entries: [DEBIT('2026-05-01', 999)],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.opening, 0);
    assert.strictEqual(out.closing, 0);
});

test('with no range at all, everything counts as movement', () => {
    const out = periodBalance({
        opening: 100,
        entries: [DEBIT('2020-01-01', 40), CREDIT('2030-01-01', 10)],
    });
    assert.strictEqual(out.opening, 100);
    assert.strictEqual(out.closing, 130);
});

test('an entry with no date is treated as in-range movement, never as opening', () => {
    const out = periodBalance({
        opening: 0,
        entries: [{ voucher_date: null, amount: -75, is_debit: true }],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.opening, 0);
    assert.strictEqual(out.closing, 75);
});

test('empty input yields a zeroed result rather than NaN', () => {
    const out = periodBalance({});
    assert.deepStrictEqual(out, { opening: 0, debit: 0, credit: 0, closing: 0 });
});

test('drCr labels a balance the way Tally does', () => {
    assert.deepStrictEqual(drCr(8418845.15), { amount: 8418845.15, dc: 'Dr' });
    assert.deepStrictEqual(drCr(-2665366.42), { amount: 2665366.42, dc: 'Cr' });
    assert.deepStrictEqual(drCr(0), { amount: 0, dc: '' });
});

test('a Date object works as well as a YYYY-MM-DD string', () => {
    const out = periodBalance({
        opening: 0,
        entries: [{ voucher_date: new Date(2026, 3, 10), amount: -60, is_debit: true }],
        from: '2026-04-01', to: '2026-04-30',
    });
    assert.strictEqual(out.debit, 60);
});
