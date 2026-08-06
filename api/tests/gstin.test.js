const test = require('node:test');
const assert = require('node:assert');
const { isValidGstin, decodeGstin } = require('../Helpers/gstin');

// GSTIN का 15वाँ अक्षर बाक़ी 14 से गणित द्वारा निकलता है, इसलिए ग़लत टाइप हुआ
// नंबर बिना कहीं पूछे पकड़ा जा सकता है।
test('a well-formed GSTIN with a correct check digit passes', () => {
    assert.strictEqual(isValidGstin('27AAPFU0939F1ZV'), true);
});

test('the same GSTIN with a wrong check digit fails', () => {
    assert.strictEqual(isValidGstin('27AAPFU0939F1ZA'), false);
});

test('wrong length or shape fails without throwing', () => {
    for (const bad of ['', '27AAPFU0939F1Z', '27AAPFU0939F1ZVX', 'ABCDEFGHIJKLMNO', null, undefined]) {
        assert.strictEqual(isValidGstin(bad), false, `expected ${bad} to be rejected`);
    }
});

test('decodeGstin pulls out the state, the PAN and the entity number', () => {
    const d = decodeGstin('27AAPFU0939F1ZV');
    assert.strictEqual(d.stateCode, '27');
    assert.strictEqual(d.stateName, 'Maharashtra');
    assert.strictEqual(d.pan, 'AAPFU0939F');
    assert.strictEqual(d.entityNumber, '1');
    assert.strictEqual(d.checkDigit, 'V');
});

test('decodeGstin returns null for an invalid GSTIN rather than guessing', () => {
    assert.strictEqual(decodeGstin('27AAPFU0939F1ZA'), null);
});

test('an unknown state code yields a null state name, not an invented one', () => {
    const { stateNameForCode } = require('../Helpers/gstin');
    assert.strictEqual(stateNameForCode('99'), null);
});
