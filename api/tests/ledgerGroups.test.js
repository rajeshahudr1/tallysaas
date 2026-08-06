'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    bucketFor, resolveBuckets, resolvePrimaryGroups, sumBalances,
} = require('../Helpers/ledgerGroups');

// A realistic slice of a Tally chart of accounts. Note that Tally's own
// PRIMARYGROUP for "Cash-in-hand" is "Current Assets" — NOT "Cash-in-hand" —
// which is exactly why bucketing walks the parent chain by reserved-group NAME
// instead of trusting that column.
const GROUPS = [
    { name: 'Current Assets',      parent: '',                    primary_group: 'Current Assets' },
    { name: 'Cash-in-hand',        parent: 'Current Assets',      primary_group: 'Current Assets' },
    { name: 'Petty Cash',          parent: 'Cash-in-hand',        primary_group: 'Current Assets' },
    { name: 'Bank Accounts',       parent: 'Current Assets',      primary_group: 'Current Assets' },
    { name: 'HDFC Group',          parent: 'Bank Accounts',       primary_group: 'Current Assets' },
    { name: 'Bank OD A/c',         parent: 'Loans (Liability)',   primary_group: 'Loans (Liability)' },
    { name: 'Current Liabilities', parent: '',                    primary_group: 'Current Liabilities' },
    { name: 'Sundry Creditors',    parent: 'Current Liabilities', primary_group: 'Current Liabilities' },
    { name: 'Local Creditors',     parent: 'Sundry Creditors',    primary_group: 'Current Liabilities' },
    { name: 'Sundry Debtors',      parent: 'Current Assets',      primary_group: 'Current Assets' },
];

test('bucketFor maps the reserved group names and nothing else', () => {
    assert.strictEqual(bucketFor('Cash-in-hand'), 'cash');
    assert.strictEqual(bucketFor('Bank Accounts'), 'bank');
    assert.strictEqual(bucketFor('Bank OD A/c'), 'bank');
    assert.strictEqual(bucketFor('Bank OCC A/c'), 'bank');
    assert.strictEqual(bucketFor('Sundry Creditors'), 'payables');
    assert.strictEqual(bucketFor('Sundry Debtors'), 'receivables');
    assert.strictEqual(bucketFor('Current Assets'), null);
    assert.strictEqual(bucketFor(null), null);
    assert.strictEqual(bucketFor(''), null);
});

test('bucketFor is case- and whitespace-insensitive', () => {
    assert.strictEqual(bucketFor('  cash-in-hand '), 'cash');
    assert.strictEqual(bucketFor('BANK ACCOUNTS'), 'bank');
});

test('resolveBuckets walks the parent chain to the reserved ancestor', () => {
    const m = resolveBuckets(GROUPS);
    assert.strictEqual(m.get('Cash-in-hand'), 'cash');
    assert.strictEqual(m.get('Petty Cash'), 'cash');
    assert.strictEqual(m.get('HDFC Group'), 'bank');
    assert.strictEqual(m.get('Bank OD A/c'), 'bank');
    assert.strictEqual(m.get('Local Creditors'), 'payables');
    assert.strictEqual(m.get('Sundry Debtors'), 'receivables');
});

test('resolveBuckets does NOT bucket a non-reserved ancestor', () => {
    const m = resolveBuckets(GROUPS);
    // Current Assets is an ancestor of cash AND debtors — bucketing it would
    // double-count the whole asset side.
    assert.strictEqual(m.get('Current Assets'), null);
    assert.strictEqual(m.get('Current Liabilities'), null);
});

test('resolveBuckets falls back to primary_group when no ancestor matches', () => {
    const m = resolveBuckets([
        { name: 'Odd Group', parent: 'Nowhere', primary_group: 'Cash-in-hand' },
    ]);
    assert.strictEqual(m.get('Odd Group'), 'cash');
});

test('resolveBuckets returns null for an orphan with no usable hint', () => {
    const m = resolveBuckets([{ name: 'Stray', parent: 'Missing', primary_group: null }]);
    assert.strictEqual(m.get('Stray'), null);
});

test('resolveBuckets survives a parent cycle without hanging', () => {
    const m = resolveBuckets([
        { name: 'A', parent: 'B', primary_group: null },
        { name: 'B', parent: 'A', primary_group: null },
    ]);
    assert.strictEqual(m.get('A'), null);
    assert.strictEqual(m.get('B'), null);
});

test('resolvePrimaryGroups still reports the top-of-chain primary group', () => {
    const m = resolvePrimaryGroups(GROUPS);
    assert.strictEqual(m.get('Petty Cash'), 'Current Assets');
    assert.strictEqual(m.get('Local Creditors'), 'Current Liabilities');
});

test('sumBalances reads the inverted Tally balance sign', () => {
    // tally_ledgers mirrors Tally verbatim: a DEBIT balance is stored NEGATIVE.
    // Cash/bank/debtors are debit-balance accounts, creditors credit-balance.
    const ledgers = [
        { parent: 'Cash-in-hand',    closing_balance: '-84000.00' },
        { parent: 'Petty Cash',      closing_balance: '-18845.00' },
        { parent: 'HDFC Group',      closing_balance: '-1368683.00' },
        { parent: 'Local Creditors', closing_balance: '2302466.00' },
        { parent: 'Sundry Debtors',  closing_balance: '-999999.00' },
    ];
    const out = sumBalances(ledgers, GROUPS);
    assert.strictEqual(out.cash, 84000 + 18845);
    assert.strictEqual(out.bank, 1368683);
    assert.strictEqual(out.payables, 2302466);      // returned positive
    assert.strictEqual(out.receivables, 999999);
});

test('sumBalances returns zeros for a company with no ledgers', () => {
    assert.deepStrictEqual(sumBalances([], []),
        { cash: 0, bank: 0, payables: 0, receivables: 0 });
});

test('sumBalances ignores ledgers whose group is unknown', () => {
    const out = sumBalances([{ parent: 'Nowhere', closing_balance: '500' }], GROUPS);
    assert.deepStrictEqual(out, { cash: 0, bank: 0, payables: 0, receivables: 0 });
});
