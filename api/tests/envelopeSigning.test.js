'use strict';

/**
 * Serving Tally envelopes from the server is what lets a new report ship
 * without a new exe. It also means the server can tell thousands of installed
 * agents what XML to send to their customers' Tally — and Tally's XML API
 * writes as well as reads.
 *
 * Two independent controls stop that becoming a remote-write channel, and both
 * are tested here:
 *
 *   1. A SIGNATURE the web tier cannot produce on its own, so a compromised
 *      server cannot mint envelopes.
 *   2. A READ-ONLY CHECK, which holds even if the signing key leaks.
 *
 * The tests that matter are the refusals.
 */

const test = require('node:test');
const assert = require('node:assert');

const es = require('../Helpers/envelopeSigning');

const SECRET = 'test-signing-secret';
const OTHER = 'a-different-secret';

const READ_XML =
    '<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>'
    + '<ID>Ledger</ID></HEADER></ENVELOPE>';

const setOf = (xml = READ_XML) => ({
    id: 'set-1',
    envelopes: { ledger: { xml } },
});

// ── Signing ──────────────────────────────────────────────────────
test('a payload verifies against its own signature', () => {
    const payload = setOf();
    const { signature } = es.sign(payload, SECRET);
    assert.equal(es.verify(payload, signature, SECRET), true);
});

test('a signature made with another secret is refused', () => {
    const payload = setOf();
    const { signature } = es.sign(payload, OTHER);
    assert.equal(es.verify(payload, signature, SECRET), false);
});

test('altering the XML after signing invalidates the signature', () => {
    // The whole point: an envelope changed in transit must not verify.
    const payload = setOf();
    const { signature } = es.sign(payload, SECRET);
    payload.envelopes.ledger.xml = READ_XML.replace('Ledger', 'Voucher');
    assert.equal(es.verify(payload, signature, SECRET), false);
});

test('adding an envelope after signing invalidates the signature', () => {
    const payload = setOf();
    const { signature } = es.sign(payload, SECRET);
    payload.envelopes.extra = { xml: READ_XML };
    assert.equal(es.verify(payload, signature, SECRET), false);
});

test('key order does not change the signature', () => {
    // Two structurally identical payloads must sign identically, or a harmless
    // re-serialisation breaks every agent in the field.
    const a = { id: 'x', envelopes: { one: { xml: 'A' }, two: { xml: 'B' } } };
    const b = { envelopes: { two: { xml: 'B' }, one: { xml: 'A' } }, id: 'x' };
    assert.equal(es.sign(a, SECRET).signature, es.sign(b, SECRET).signature);
});

test('an attacker-chosen algorithm is refused', () => {
    // The JWT alg:none hole. The verifier picks the algorithm, never the input.
    const payload = setOf();
    const { signature } = es.sign(payload, SECRET);
    assert.equal(es.verify(payload, signature, SECRET, 'none'), false);
    assert.equal(es.verify(payload, signature, SECRET, 'hmac-sha1'), false);
});

test('a missing signature or secret verifies false rather than throwing', () => {
    const payload = setOf();
    assert.equal(es.verify(payload, '', SECRET), false);
    assert.equal(es.verify(payload, 'abc', ''), false);
    assert.equal(es.verify(payload, null, SECRET), false);
});

test('signing with no secret is an error, not an unsigned payload', () => {
    // Failing open here would publish envelopes nothing could verify.
    assert.throws(() => es.sign(setOf(), ''));
});

test('the signed bytes carry the version', () => {
    // Without it, a future format change could make old signatures verify
    // against new data by coincidence.
    assert.ok(es.canonical(setOf()).startsWith(es.SIG_VERSION + '\n'));
});

// ── Read-only enforcement ────────────────────────────────────────
test('an export envelope is accepted', () => {
    assert.equal(es.assertReadOnly(READ_XML).ok, true);
});

test('an IMPORT request is refused', () => {
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import</TALLYREQUEST></HEADER></ENVELOPE>';
    assert.equal(es.assertReadOnly(xml).ok, false);
});

test('object mutation attributes are refused', () => {
    for (const xml of [
        '<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>',
        '<ENVELOPE><VOUCHER ACTION="Create"/></ENVELOPE>',
        '<ENVELOPE><LEDGER ACTION="Alter"/></ENVELOPE>',
        '<ENVELOPE><COLLECTION ISMODIFY="Yes"/></ENVELOPE>',
        '<ENVELOPE><VOUCHER ISDELETE="Yes"/></ENVELOPE>',
    ]) {
        assert.equal(es.assertReadOnly(xml).ok, false, xml);
    }
});

test('an IMPORTDATA body is refused', () => {
    assert.equal(es.assertReadOnly('<ENVELOPE><BODY><IMPORTDATA/></BODY></ENVELOPE>').ok, false);
});

test('the check is case-insensitive', () => {
    // Tally accepts either case, so a lowercase attack must not slip past.
    assert.equal(es.assertReadOnly('<envelope><voucher action="delete"/></envelope>').ok, false);
});

test('an empty envelope is refused rather than treated as harmless', () => {
    assert.equal(es.assertReadOnly('').ok, false);
    assert.equal(es.assertReadOnly('   ').ok, false);
    assert.equal(es.assertReadOnly(null).ok, false);
});

// ── Publishing a set ─────────────────────────────────────────────
test('a clean set signs and verifies', () => {
    const signed = es.signEnvelopeSet(setOf(), SECRET);
    assert.equal(signed.alg, es.ALG);
    const { signature, alg, version, ...payload } = signed;
    assert.equal(es.verify(payload, signature, SECRET), true);
});

test('ONE writable envelope refuses the WHOLE set', () => {
    // Publishing "the safe ones" would leave the operator believing the set
    // shipped while a report they are relying on is quietly missing.
    const set = {
        id: 'set-2',
        envelopes: {
            ledger: { xml: READ_XML },
            bad: { xml: '<ENVELOPE><VOUCHER ACTION="Delete"/></ENVELOPE>' },
        },
    };
    assert.throws(() => es.signEnvelopeSet(set, SECRET), /Refusing to sign "bad"/);
});

test('the signature is not part of what was signed', () => {
    // Otherwise re-verifying a published set could never reproduce the bytes.
    const signed = es.signEnvelopeSet(setOf(), SECRET);
    assert.equal(es.verify(signed, signed.signature, SECRET), false);
});
