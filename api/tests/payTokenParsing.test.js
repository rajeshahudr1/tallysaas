'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToken } = require('../Controllers/Public/PayController');

test('a valid <licenseId>.<random> token parses into its parts', () => {
    const random = 'a'.repeat(48);
    const parsed = parseToken(`7.${random}`);
    assert.deepStrictEqual(parsed, { licenseId: 7, random });
});

test('a token with no licence part (old shape / bare random) fails to parse', () => {
    assert.strictEqual(parseToken('a'.repeat(48)), null);
});

test('a token with a non-numeric licence part fails to parse', () => {
    assert.strictEqual(parseToken(`abc.${'a'.repeat(48)}`), null);
});

test('a token with licence id 0 or negative fails to parse', () => {
    assert.strictEqual(parseToken(`0.${'a'.repeat(48)}`), null);
});

test('a malformed token (extra dots, empty random) fails to parse', () => {
    assert.strictEqual(parseToken('7.'), null);
    assert.strictEqual(parseToken('7.abc.def'), null);
    assert.strictEqual(parseToken(''), null);
});

test('a syntactically valid token for a licence that does not exist still parses — the 404 for that case comes from the tenant db lookup finding no row, not from parsing', () => {
    // parseToken only validates shape; whether licence 999999 exists is a
    // lookup concern handled by PayController.show, not this function.
    const parsed = parseToken(`999999.${'b'.repeat(48)}`);
    assert.deepStrictEqual(parsed, { licenseId: 999999, random: 'b'.repeat(48) });
});
