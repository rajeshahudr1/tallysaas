'use strict';

/**
 * api/Helpers/keyCrypto.js
 *
 * Reversible (AES-256-GCM) encryption for the secret license key, so a
 * super-admin can REVEAL the full key on the license detail page. This is the
 * ONLY place keys are encrypted/decrypted; it is used by the super-admin
 * LicenseController (create / get / regenerate) — both routes are already
 * super-admin guarded.
 *
 * Format of an encrypted blob (base64):
 *
 *   base64( iv(12 bytes) || authTag(16 bytes) || ciphertext )
 *
 * The 256-bit AES key is derived as sha256(LICENSE_KEY_SECRET), so the secret
 * in the .env can be any length (we recommend a 64-hex / 32-byte value).
 *
 * Safety contract (callers depend on this):
 *   • encryptKey(plain)  → base64 blob, or null when not configured / bad input.
 *   • decryptKey(blob)   → clear string, or null when the blob is empty/invalid
 *                          or the secret is missing/wrong. NEVER throws to the
 *                          caller — a decrypt failure degrades to key_available:
 *                          false, never a 500.
 *   • isConfigured()     → true when LICENSE_KEY_SECRET is present.
 *
 * NEVER log plaintext keys.
 */

const crypto = require('node:crypto');

const ALGO       = 'aes-256-gcm';
const IV_LEN     = 12;   // GCM standard nonce length
const TAG_LEN    = 16;   // GCM auth tag length

// Warn at most once per process so a misconfiguration is visible in the logs
// without spamming on every license view.
let _warnedNoSecret = false;
function warnOnce(msg) {
    if (_warnedNoSecret) return;
    _warnedNoSecret = true;
    console.warn(msg);
}

/** True when LICENSE_KEY_SECRET is configured (non-empty). */
function isConfigured() {
    const s = process.env.LICENSE_KEY_SECRET;
    return !!(s && String(s).trim());
}

/** Derive the 32-byte AES key as sha256(LICENSE_KEY_SECRET), or null. */
function deriveKey() {
    if (!isConfigured()) return null;
    return crypto.createHash('sha256').update(String(process.env.LICENSE_KEY_SECRET)).digest();
}

/**
 * Encrypt a clear license key → base64( iv || authTag || ciphertext ).
 * Returns null when not configured or the input is empty/invalid (so the caller
 * simply stores NULL and the key stays unrevealable, never a crash).
 */
function encryptKey(plain) {
    try {
        if (plain == null || plain === '') return null;
        const key = deriveKey();
        if (!key) {
            warnOnce('keyCrypto: LICENSE_KEY_SECRET is not set — license keys will be stored UNENCRYPTED-ABSENT (not revealable).');
            return null;
        }
        const iv     = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv(ALGO, key, iv);
        const ct     = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const tag    = cipher.getAuthTag();
        return Buffer.concat([iv, tag, ct]).toString('base64');
    } catch (err) {
        // Do not leak the plaintext; just note that encryption failed.
        console.warn('keyCrypto.encryptKey failed:', err && err.message);
        return null;
    }
}

/**
 * Decrypt a base64 blob produced by encryptKey → the clear license key.
 * Returns null for empty/invalid input, a missing/wrong secret, or any failure
 * (tampered blob, wrong key, …). NEVER throws to the caller.
 */
function decryptKey(blob) {
    try {
        if (blob == null || blob === '') return null;
        const key = deriveKey();
        if (!key) {
            warnOnce('keyCrypto: LICENSE_KEY_SECRET is not set — cannot decrypt stored license keys.');
            return null;
        }
        const raw = Buffer.from(String(blob), 'base64');
        if (raw.length <= IV_LEN + TAG_LEN) return null;   // too short to be valid
        const iv  = raw.subarray(0, IV_LEN);
        const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const ct  = raw.subarray(IV_LEN + TAG_LEN);
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    } catch (err) {
        // Wrong secret / tampered blob / malformed base64 — degrade gracefully.
        console.warn('keyCrypto.decryptKey failed (returning null):', err && err.message);
        return null;
    }
}

module.exports = { encryptKey, decryptKey, isConfigured };
