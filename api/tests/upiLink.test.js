'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildUpiUri } = require('../Helpers/upiLink');

test('a normal request builds a valid UPI URI', () => {
    const uri = buildUpiUri({ vpa: 'shop@okhdfcbank', payeeName: 'Shree Traders', amount: 1250.5, note: 'INV-2026-0001' });
    assert.ok(uri.startsWith('upi://pay?'));
    assert.ok(uri.includes('pa=shop%40okhdfcbank'));
    assert.ok(uri.includes('am=1250.50'));
    assert.ok(uri.includes('cu=INR'));
});

test('the payee name and note are encoded, not pasted raw', () => {
    const uri = buildUpiUri({ vpa: 'a@b', payeeName: 'A & B Traders', amount: 10, note: 'INV 1/2' });
    assert.ok(!uri.includes('A & B'), 'an unencoded ampersand would break the query string');
    assert.ok(uri.includes('pn=A%20%26%20B%20Traders') || uri.includes('pn=A+%26+B+Traders'));
});

test('a missing or malformed VPA yields null rather than a broken link', () => {
    for (const bad of [undefined, '', 'no-at-sign', '@nohandle', 'handle@']) {
        assert.strictEqual(buildUpiUri({ vpa: bad, payeeName: 'X', amount: 10 }), null, `expected ${bad} to be refused`);
    }
});

test('a non-positive amount yields null — a payment link for zero is meaningless', () => {
    assert.strictEqual(buildUpiUri({ vpa: 'a@b', payeeName: 'X', amount: 0 }), null);
    assert.strictEqual(buildUpiUri({ vpa: 'a@b', payeeName: 'X', amount: -5 }), null);
});

test('the amount always carries two decimals', () => {
    assert.ok(buildUpiUri({ vpa: 'a@b', payeeName: 'X', amount: 7 }).includes('am=7.00'));
});
