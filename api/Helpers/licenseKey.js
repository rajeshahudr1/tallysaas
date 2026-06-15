'use strict';

/**
 * api/Helpers/licenseKey.js
 *
 * Generation + verification for the secret Tally-agent license key.
 *
 *   key    = "TCS-XXXXX-XXXXX-XXXXX-XXXXX"  (Crockford base32, no ambiguous
 *            chars). Shown to the admin ONCE at creation; never stored in clear.
 *   prefix = "TCS-XXXXX"  (first group) — NON-secret. Stored + used to look up
 *            the row fast, and shown in the UI so the admin can identify a key.
 *   hash   = sha256(key) hex — what we store + compare on activation.
 *
 * Security model: the key is a *credential only*. It carries NO entitlement —
 * plan/limits/validity all live in the `licenses` row and are enforced
 * server-side on every agent call, so a leaked or copied key can't be used to
 * fake access, and a license can be suspended instantly from the cloud.
 */

const crypto = require('node:crypto');

// Crockford base32 alphabet (excludes I, L, O, U to avoid confusion).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 4;          // groups AFTER the "TCS" tag
const GROUP_LEN = 5;

function randomGroup() {
    const bytes = crypto.randomBytes(GROUP_LEN);
    let out = '';
    for (let i = 0; i < GROUP_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}

function hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Generate a fresh license key.
 * @returns {{ key: string, prefix: string, hash: string }}
 */
function generate() {
    const groups = [];
    for (let i = 0; i < GROUPS; i++) groups.push(randomGroup());
    const key    = 'TCS-' + groups.join('-');
    const prefix = 'TCS-' + groups[0];
    return { key, prefix, hash: hashKey(key) };
}

/**
 * Derive the lookup prefix + hash from a presented key (for activation).
 * Returns null when the key is malformed.
 * @returns {null | { prefix: string, hash: string }}
 */
function parse(key) {
    if (typeof key !== 'string') return null;
    const k = key.trim().toUpperCase();
    const m = k.match(/^TCS-([0-9A-Z]{5})-([0-9A-Z]{5})-([0-9A-Z]{5})-([0-9A-Z]{5})$/);
    if (!m) return null;
    return { prefix: 'TCS-' + m[1], hash: hashKey(k) };
}

module.exports = { generate, parse, hashKey };
