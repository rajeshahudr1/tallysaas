'use strict';

/**
 * reconcileOutstanding compares the cloud's DERIVED ageing against Tally's own
 * Bills Receivable / Payable. The cases that matter are the asymmetric ones —
 * a party on only one side — because those are exactly what an inner-join
 * comparison hides, and they are the two real failure modes: a bill we invented
 * and a bill we lost.
 */

const test = require('node:test');
const assert = require('node:assert');

const { reconcileOutstanding, TOLERANCE } = require('../Helpers/tallyReconciliation');

const p = (party, amount) => ({ party, amount });

test('identical figures reconcile clean', () => {
    const r = reconcileOutstanding(
        [p('Acme', 10000), p('Globex', 2500)],
        [p('Acme', 10000), p('Globex', 2500)],
    );
    assert.equal(r.ok, true);
    assert.equal(r.parties, 2);
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.totals.difference, 0);
});

test('a differing amount names the party and the rupee gap', () => {
    const r = reconcileOutstanding([p('Acme', 12000)], [p('Acme', 10000)]);
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 1);
    assert.deepEqual(r.mismatches[0],
        { party: 'acme', derived: 12000, tally: 10000, difference: 2000 });
});

test('a bill Tally has and the cloud does not is reported, not skipped', () => {
    // The mirror dropped something — the failure worth catching most.
    const r = reconcileOutstanding([], [p('Acme', 10000)]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing_in_cloud, [{ party: 'acme', tally: 10000 }]);
    assert.deepEqual(r.missing_in_tally, []);
});

test('a bill the cloud shows and Tally does not is reported too', () => {
    // Usually a settled bill the cloud never cleared.
    const r = reconcileOutstanding([p('Globex', 500)], []);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing_in_tally, [{ party: 'globex', derived: 500 }]);
    assert.deepEqual(r.missing_in_cloud, []);
});

test('several bills for one party are summed before comparing', () => {
    // Tally lists outstanding BILL by bill; the derived side is per party. A
    // naive row-to-row compare would call this a mismatch on every party.
    const r = reconcileOutstanding(
        [p('Acme', 7000)],
        [p('Acme', 3000), p('Acme', 4000)],
    );
    assert.equal(r.ok, true);
    assert.equal(r.totals.tally, 7000);
});

test('party matching ignores case and surrounding space', () => {
    const r = reconcileOutstanding([p('  Acme Ltd ', 100)], [p('ACME LTD', 100)]);
    assert.equal(r.ok, true);
    assert.equal(r.parties, 1);
});

test('float noise under tolerance is not a mismatch', () => {
    const r = reconcileOutstanding([p('Acme', 10000)], [p('Acme', 10000 + TOLERANCE / 2)]);
    assert.equal(r.ok, true);
});

test('a difference just above tolerance IS a mismatch', () => {
    const r = reconcileOutstanding([p('Acme', 10000)], [p('Acme', 10000.02)]);
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 1);
});

test('unnamed rows are ignored rather than collapsing into one bucket', () => {
    // A blank party would otherwise become a single '' key holding everyone's
    // unattributed bills, and reconcile clean by accident.
    const r = reconcileOutstanding(
        [p('', 999), p('Acme', 100)],
        [p('   ', 12), p('Acme', 100)],
    );
    assert.equal(r.ok, true);
    assert.equal(r.parties, 1);
});

test('empty on both sides is a clean pass, not a crash', () => {
    const r = reconcileOutstanding([], []);
    assert.equal(r.ok, true);
    assert.equal(r.parties, 0);
    assert.equal(r.totals.difference, 0);
});
