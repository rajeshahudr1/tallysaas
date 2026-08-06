'use strict';

/**
 * api/Helpers/envelopeSigning.js
 *
 * Signs the Tally request envelopes the server hands to agents, and verifies
 * them on the way back in.
 *
 * WHY SIGNING IS NOT OPTIONAL HERE
 * --------------------------------
 * Serving envelopes from the server is what lets a new report ship without a
 * new exe. It also means the server can tell every installed agent what XML to
 * send to the customer's Tally — and Tally's XML API writes as well as reads.
 * So the same channel that delivers "fetch the Balance Sheet" could deliver
 * "delete these vouchers", to thousands of machines, if anything ever got
 * between the agent and the server or into the server itself.
 *
 * HTTPS alone does not cover that: it protects the pipe, not the payload, and
 * it stops meaning anything the moment the thing at the far end is not us. A
 * detached signature does cover it, because the signing key never sits on the
 * web tier at all — it lives wherever envelopes are published from.
 *
 * The agent therefore refuses any envelope it cannot verify, and keeps using
 * the last VERIFIED set it cached rather than accepting a new unverified one.
 * A compromised or unreachable server degrades to "yesterday's queries", never
 * to "whatever it says".
 *
 * WHY HMAC RATHER THAN A PUBLIC KEY
 * ---------------------------------
 * A shared secret means the verifying secret ships inside the agent, so anyone
 * who unpacks the exe can FORGE an envelope for an agent they already control —
 * which buys them nothing, since they own that machine already. What it must
 * stop is one customer's agent being fed envelopes by anyone other than us, and
 * a shared secret does that. Ed25519 would be strictly better (nothing
 * verifiable is shippable), and this module is deliberately shaped so the
 * algorithm can be swapped without changing either caller: `sign` and `verify`
 * carry an explicit `alg`.
 */

const crypto = require('node:crypto');

// Bumped when the signed byte-layout changes. Without it, a future format
// change would make old signatures verify against new data by coincidence.
const SIG_VERSION = 'v1';
const ALG = 'hmac-sha256';

/**
 * The exact bytes that get signed.
 *
 * Canonical JSON with SORTED KEYS: two structurally identical payloads must
 * produce one signature, or a harmless re-serialisation (a different Node
 * version, a field added and removed) silently breaks every agent.
 *
 * The version and the envelope-set id are inside the signed bytes, not
 * alongside them, so neither can be swapped after signing.
 */
function canonical(payload) {
    return `${SIG_VERSION}\n${stableStringify(payload)}`;
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Sign a payload. Returns `{ alg, version, signature }`. */
function sign(payload, secret) {
    if (!secret) throw new Error('No signing secret configured.');
    const signature = crypto.createHmac('sha256', secret)
        .update(canonical(payload), 'utf8')
        .digest('base64');
    return { alg: ALG, version: SIG_VERSION, signature };
}

/**
 * Verify a signature. Returns true only for an exact match.
 *
 * Every failure returns false rather than throwing: a caller that wraps this in
 * a try/catch and treats "threw" as "probably fine" is a bug waiting to happen,
 * so there is nothing to catch.
 */
function verify(payload, signature, secret, alg = ALG) {
    if (!secret || !signature) return false;
    // An attacker choosing the algorithm is the classic JWT `alg:none` hole.
    if (alg !== ALG) return false;
    let expected;
    try {
        expected = sign(payload, secret).signature;
    } catch (_) {
        return false;
    }
    const a = Buffer.from(String(signature), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Reject an envelope that asks Tally to CHANGE something.
 *
 * Defence in depth, and the one check that does not depend on a key staying
 * secret. The pull path has no business importing, altering or deleting
 * anything, so a signed-but-wrong envelope — a mistake in the publishing tool,
 * or a signing key that did leak — still cannot reach into a customer's books.
 *
 * Enforced on BOTH sides: here, so a bad envelope is never published, and again
 * in the agent, so one that somehow was published is never executed.
 */
const FORBIDDEN = [
    // Tally's request verbs that write.
    /<TALLYREQUEST>\s*IMPORT\s*<\/TALLYREQUEST>/i,
    /<TALLYREQUEST>\s*(ALTER|CREATE|DELETE)\b/i,
    // Data-carrying import bodies.
    /<IMPORTDATA\b/i,
    /<REQUESTDATA\b/i,
    // Object mutation attributes.
    /\bACTION\s*=\s*["'](Create|Alter|Delete|Cancel)["']/i,
    /\bISMODIFY\s*=\s*["']Yes["']/i,
    /\bISDELETE\s*=\s*["']Yes["']/i,
];

/**
 * @returns {{ok:boolean, reason?:string}}
 */
function assertReadOnly(xml) {
    const text = String(xml || '');
    if (!text.trim()) return { ok: false, reason: 'empty envelope' };
    for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
            return { ok: false, reason: `envelope can modify Tally (${pattern})` };
        }
    }
    return { ok: true };
}

/**
 * Validate and sign a whole envelope set before it is published.
 *
 * Refuses the entire set if ANY envelope is writable. Publishing "the safe
 * ones" would leave the operator believing the set shipped while a report they
 * are counting on is quietly missing.
 */
function signEnvelopeSet(set, secret) {
    const envelopes = (set && set.envelopes) || {};
    for (const [name, def] of Object.entries(envelopes)) {
        const check = assertReadOnly(def && def.xml);
        if (!check.ok) {
            throw new Error(`Refusing to sign "${name}": ${check.reason}`);
        }
    }
    return { ...set, ...sign(set, secret) };
}

module.exports = {
    SIG_VERSION,
    ALG,
    canonical,
    stableStringify,
    sign,
    verify,
    assertReadOnly,
    signEnvelopeSet,
};
