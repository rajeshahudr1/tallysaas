'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildBills, buildOutstanding } = require('../Helpers/billwiseOutstanding');

// Tally's signed convention: a sales invoice CREDITS the customer (negative),
// a receipt DEBITS them (positive). See the helper's SIGN CONVENTION note.
const invoice = (party, bill, amount, date, due = null) => ({
    ledger_name: party, bill_name: bill, bill_type: 'New Ref',
    amount: -amount, voucher_date: date, bill_date: date, due_date: due,
});
const receipt = (party, bill, amount, date) => ({
    ledger_name: party, bill_name: bill, bill_type: 'Agst Ref',
    amount, voucher_date: date,
});

const AS_ON = '2026-06-01';

test('a fully settled bill disappears from outstanding', () => {
    const bills = buildBills([
        invoice('Acme', 'S-1', 10000, '2026-04-01'),
        receipt('Acme', 'S-1', 10000, '2026-04-20'),
    ], { asOn: AS_ON });
    assert.deepEqual(bills, []);
});

test('a partly settled bill reports only the remainder', () => {
    const [b] = buildBills([
        invoice('Acme', 'S-1', 10000, '2026-04-01'),
        receipt('Acme', 'S-1', 4000, '2026-04-20'),
    ], { asOn: AS_ON });
    assert.equal(b.outstanding, 6000);
    assert.equal(b.opened, 10000);
    assert.equal(b.settled, 4000);
});

test('a receipt is applied to the bill it NAMES, not to the oldest one', () => {
    // This is the whole point of bill-wise: FIFO would settle S-1 (older) and
    // leave S-2 open, reporting the wrong invoice as overdue.
    const bills = buildBills([
        invoice('Acme', 'S-1', 10000, '2026-01-01'),   // old, disputed
        invoice('Acme', 'S-2', 5000,  '2026-05-01'),   // recent, paid
        receipt('Acme', 'S-2', 5000,  '2026-05-10'),
    ], { asOn: AS_ON });

    assert.equal(bills.length, 1);
    assert.equal(bills[0].bill, 'S-1');
    assert.equal(bills[0].outstanding, 10000);
    assert.equal(bills[0].bucket, '135 - 180 Days');   // aged from Jan, not May
});

test('bill age is measured from the invoice, not from the last receipt', () => {
    const [b] = buildBills([
        invoice('Acme', 'S-1', 10000, '2026-01-01'),
        receipt('Acme', 'S-1', 1000, '2026-05-28'),    // a recent part payment
    ], { asOn: AS_ON });
    assert.equal(b.opened_on, '2026-01-01');
    assert.equal(b.days, 151);
});

test('credit period drives overdue, so a bill inside its terms is not overdue', () => {
    const rows = [invoice('Acme', 'S-1', 10000, '2026-05-20', '2026-06-19')];
    const [b] = buildBills(rows, { asOn: AS_ON });
    assert.equal(b.is_overdue, false);
    assert.equal(b.overdue_days, -18);

    const [late] = buildBills(
        [invoice('Acme', 'S-2', 10000, '2026-03-01', '2026-03-31')], { asOn: AS_ON });
    assert.equal(late.is_overdue, true);
    assert.equal(late.overdue_days, 62);
});

test('a bill with no credit terms is overdue from its own date', () => {
    const [b] = buildBills([invoice('Acme', 'S-1', 10000, '2026-05-01')], { asOn: AS_ON });
    assert.equal(b.is_overdue, true);
    assert.equal(b.overdue_days, 31);
});

test('an unallocated amount is kept under "(on account)" rather than dropped', () => {
    const [b] = buildBills([{
        ledger_name: 'Acme', bill_name: '', bill_type: 'On Account',
        amount: -2500, voucher_date: '2026-05-01',
    }], { asOn: AS_ON });
    assert.equal(b.bill, '(on account)');
    assert.equal(b.outstanding, 2500);
});

test('an advance nets against the party as a negative (we owe them)', () => {
    const out = buildOutstanding([
        receipt('Acme', 'ADV-1', 3000, '2026-05-01'),
    ], { asOn: AS_ON });
    assert.equal(out.receivable.total, 0);
    assert.equal(out.payable.total, 3000);
    assert.equal(out.payable.bills[0].outstanding, 3000);
});

test('float drift never leaves a settled bill open', () => {
    const bills = buildBills([
        invoice('Acme', 'S-1', 0.1, '2026-04-01'),
        invoice('Acme', 'S-1', 0.2, '2026-04-01'),
        receipt('Acme', 'S-1', 0.3, '2026-04-02'),
    ], { asOn: AS_ON });
    assert.deepEqual(bills, []);
});

test('buildOutstanding splits receivable from payable and totals per party', () => {
    const out = buildOutstanding([
        invoice('Acme', 'S-1', 10000, '2026-01-01'),
        invoice('Acme', 'S-2', 5000,  '2026-05-01'),
        invoice('Beta', 'S-3', 2000,  '2026-05-15'),
        receipt('Beta', 'S-3', 6000,  '2026-05-20'),   // overpaid -> we owe Beta
    ], { asOn: AS_ON });

    assert.equal(out.receivable.total, 15000);
    assert.equal(out.payable.total, 4000);

    const acme = out.receivable.parties.find((p) => p.party === 'Acme');
    assert.equal(acme.outstanding, 15000);
    assert.equal(acme.bills, 2);

    const bucketTotal = out.receivable.buckets.reduce((s, b) => s + b.amount, 0);
    assert.equal(bucketTotal, out.receivable.total, 'buckets must sum to the total');
});

test('bills from different parties with the same bill number stay separate', () => {
    const bills = buildBills([
        invoice('Acme', 'INV-1', 1000, '2026-05-01'),
        invoice('Beta', 'INV-1', 2000, '2026-05-01'),
        receipt('Acme', 'INV-1', 1000, '2026-05-02'),
    ], { asOn: AS_ON });
    assert.equal(bills.length, 1);
    assert.equal(bills[0].party, 'Beta');
});
