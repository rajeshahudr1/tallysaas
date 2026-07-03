'use strict';

/**
 * api/Modules/einvoice/lib/credVault.js
 *
 * AES-256-GCM encryption for GSP credentials AT REST. The 32-byte key comes from
 * env `EINVOICE_ENC_KEY` (64-hex OR base64) — never hardcoded, never in the DB.
 * Ciphertext layout: base64( iv[12] || authTag[16] || ciphertext ). Authenticated
 * encryption means a tampered ciphertext fails to decrypt (throws) rather than
 * yielding garbage. If the key is not configured, encrypt/decrypt THROW so a
 * credential is never accidentally written in plaintext.
 *
 * Dependencies: Node's built-in `crypto` only.
 */

const crypto = require('crypto');

function key() {
    const raw = (process.env.EINVOICE_ENC_KEY || '').trim();
    if (!raw) {
        throw new Error('EINVOICE_ENC_KEY is not set — refusing to store GSP credentials in plaintext.');
    }
    const buf = /^[0-9a-fA-F]{64}$/.test(raw)
        ? Buffer.from(raw, 'hex')
        : Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
        throw new Error('EINVOICE_ENC_KEY must decode to exactly 32 bytes (AES-256): pass 64 hex chars or a base64 32-byte key.');
    }
    return buf;
}

/** Encrypt a UTF-8 string → base64 blob. null/'' → null (nothing to store). */
function encrypt(plaintext) {
    if (plaintext == null || plaintext === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a base64 blob produced by encrypt() → UTF-8 string. null/'' → null. */
function decrypt(payload) {
    if (payload == null || payload === '') return null;
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when a valid 32-byte key is configured (so the UI can warn if not). */
function isConfigured() {
    try { key(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
