'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RANGE_VALUES, buildRanges, resolveRange } = require('../lib/date-ranges');

// Fixed reference date: Monday 3rd August 2026.
const REF = new Date(2026, 7, 3);

function byValue(now, value) {
    return buildRanges(now).find((r) => r.value === value);
}

test('exposes the nine presets in display order', () => {
    assert.deepStrictEqual(RANGE_VALUES, [
        'today', 'yesterday', 'this_week', 'last_week',
        'this_month', 'last_month', 'this_quarter',
        'this_year', 'last_year',
    ]);
});

test('today spans a single day and is labelled with an ordinal', () => {
    const r = byValue(REF, 'today');
    assert.strictEqual(r.from, '2026-08-03');
    assert.strictEqual(r.to, '2026-08-03');
    assert.strictEqual(r.label, "Today (3rd Aug '26)");
});

test('yesterday is the preceding day', () => {
    const r = byValue(REF, 'yesterday');
    assert.strictEqual(r.from, '2026-08-02');
    assert.strictEqual(r.to, '2026-08-02');
    assert.strictEqual(r.label, "Yesterday (2nd Aug '26)");
});

test('weeks run Monday to Monday', () => {
    const tw = byValue(REF, 'this_week');
    assert.strictEqual(tw.from, '2026-07-27');
    assert.strictEqual(tw.to, '2026-08-03');
    assert.strictEqual(tw.label, "This Week (27th Jul '26 - 3rd Aug '26)");

    const lw = byValue(REF, 'last_week');
    assert.strictEqual(lw.from, '2026-07-20');
    assert.strictEqual(lw.to, '2026-07-27');
});

test('this_month covers the whole calendar month', () => {
    const r = byValue(REF, 'this_month');
    assert.strictEqual(r.from, '2026-08-01');
    assert.strictEqual(r.to, '2026-08-31');
    assert.strictEqual(r.label, "This Month (1st Aug '26 - 31st Aug '26)");
});

test('last_month covers the previous calendar month', () => {
    const r = byValue(REF, 'last_month');
    assert.strictEqual(r.from, '2026-07-01');
    assert.strictEqual(r.to, '2026-07-31');
});

test('quarters are financial quarters starting 1 April', () => {
    const r = byValue(REF, 'this_quarter');
    assert.strictEqual(r.from, '2026-07-01');
    assert.strictEqual(r.to, '2026-09-30');
    assert.strictEqual(r.label, "This Quarter (1st Jul '26 - 30th Sep '26)");
});

test('years are financial years running 1 April to 31 March', () => {
    const r = byValue(REF, 'this_year');
    assert.strictEqual(r.from, '2026-04-01');
    assert.strictEqual(r.to, '2027-03-31');
    assert.strictEqual(r.label, "This Year (1st Apr '26 - 31st Mar '27)");

    const ly = byValue(REF, 'last_year');
    assert.strictEqual(ly.from, '2025-04-01');
    assert.strictEqual(ly.to, '2026-03-31');
});

test('a March date belongs to the financial year that started the previous April', () => {
    const march = new Date(2026, 2, 15);   // 15 Mar 2026
    const r = byValue(march, 'this_year');
    assert.strictEqual(r.from, '2025-04-01');
    assert.strictEqual(r.to, '2026-03-31');
});

test('a January date falls in the financial quarter starting 1 January', () => {
    const jan = new Date(2027, 0, 10);     // 10 Jan 2027
    const r = byValue(jan, 'this_quarter');
    assert.strictEqual(r.from, '2027-01-01');
    assert.strictEqual(r.to, '2027-03-31');
});

test('ordinals handle 1st, 2nd, 3rd, 11th, 12th, 13th, 21st', () => {
    const cases = [
        [new Date(2026, 7, 1), '1st'], [new Date(2026, 7, 2), '2nd'],
        [new Date(2026, 7, 3), '3rd'], [new Date(2026, 7, 11), '11th'],
        [new Date(2026, 7, 12), '12th'], [new Date(2026, 7, 13), '13th'],
        [new Date(2026, 7, 21), '21st'],
    ];
    for (const [d, want] of cases) {
        assert.ok(byValue(d, 'today').label.includes(want),
            `expected "${want}" in ${byValue(d, 'today').label}`);
    }
});

test('resolveRange falls back to this_year for unknown or missing values', () => {
    assert.strictEqual(resolveRange('nonsense', REF).value, 'this_year');
    assert.strictEqual(resolveRange(undefined, REF).value, 'this_year');
    assert.strictEqual(resolveRange('this_month', REF).value, 'this_month');
});
