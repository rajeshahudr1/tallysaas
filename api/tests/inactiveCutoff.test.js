'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cutoffFromDays } = require('../Helpers/inactiveCutoff');

test('rejects non-positive, non-integer and out-of-range values', () => {
    for (const bad of ['0', '-5', 'abc', '', '1.5', '99999']) {
        assert.strictEqual(cutoffFromDays(bad), null, `expected null for ${bad}`);
    }
});

test('returns a YYYY-MM-DD string for a valid day count', () => {
    const out = cutoffFromDays('90');
    assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test('a larger day count yields an earlier cutoff', () => {
    assert.ok(cutoffFromDays('365') < cutoffFromDays('30'));
});
