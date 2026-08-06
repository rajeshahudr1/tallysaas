'use strict';

/**
 * api/Helpers/agentOtp.js
 *
 * The RULES of an agent OTP challenge, with no database and no clock of its
 * own. Every decision — is this code right, has it expired, has this machine
 * changed, are there attempts left, may we resend yet — is a pure function of
 * (row, input, now).
 *
 * WHY SEPARATE FROM THE CONTROLLER: this is the security boundary of the whole
 * activation flow. A mistake here does not throw, it silently accepts something
 * it should have refused, and no integration test that only checks the happy
 * path will notice. Keeping it pure means every refusal can be tested directly
 * and cheaply, including the ones that are awkward to reproduce against a live
 * database (an expired row, a replayed code, a mismatched machine).
 *
 * The caller does the I/O: read the row, call `verifyChallenge`, then act on the
 * verdict. Verdicts carry a `reason` for logs and a `message` for the customer,
 * because the two should not be the same string — the log needs to distinguish
 * "expired" from "wrong code", and the customer must not be told which.
 */

const crypto = require('crypto');

// A code lives 10 minutes. Long enough to find the email on a phone, short
// enough that a captured code is usually already dead.
const CODE_TTL_MS = 10 * 60 * 1000;

// Six digits is a million combinations. Inside a 10-minute window that is
// brute-forceable without a cap, so the cap is the real control, not the length.
const MAX_ATTEMPTS = 5;

// Resend limits. The cooldown stops the endpoint being used as a free mailer;
// the cap stops one challenge generating unbounded mail.
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_RESENDS = 3;

/** A 6-digit code, zero-padded. Uses randomInt, never Math.random. */
function generateCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Hash a code for storage. The plaintext is emailed and then forgotten. */
function hashCode(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Constant-time compare of two hex digests.
 *
 * `===` on a hash leaks, through timing, how many leading characters matched.
 * That is a thin channel but a real one, and the fix costs nothing.
 */
function hashesEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    // Two ABSENT hashes must never compare equal. Empty buffers satisfy
    // timingSafeEqual, so a row whose code_hash was somehow null would match a
    // null candidate and let the check through — the precise shape of bug that
    // turns into an auth bypass. Refuse before comparing.
    if (!bufA.length || !bufB.length) return false;
    // timingSafeEqual throws on a length mismatch, which would itself be a
    // (much louder) leak — so unequal lengths return false without comparing.
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** Mask an email for display: "rajeshah2020@gmail.com" -> "ra***@gmail.com". */
function maskEmail(email) {
    const s = String(email || '').trim();
    const at = s.indexOf('@');
    if (at < 1) return '';
    const local = s.slice(0, at);
    const domain = s.slice(at);
    const keep = local.slice(0, Math.min(2, local.length));
    return `${keep}***${domain}`;
}

/** The row to insert for a fresh challenge. The caller supplies the id. */
function buildChallenge({ id, userId, machineId, code, now = new Date() }) {
    return {
        row: {
            id,
            user_id: userId,
            machine_id: String(machineId),
            code_hash: hashCode(code),
            expires_at: new Date(now.getTime() + CODE_TTL_MS),
            attempts: 0,
            resends: 0,
            last_sent_at: now,
            consumed_at: null,
            created_at: now,
        },
        expires_in: Math.floor(CODE_TTL_MS / 1000),
    };
}

/**
 * Decide whether a submitted code may be redeemed.
 *
 * @param {object|null} row       the challenge row, or null if not found
 * @param {object} input          { code, machineId }
 * @param {Date}   now
 * @returns {{ok:boolean, reason?:string, message?:string, attemptsLeft?:number,
 *            burn?:boolean, countAttempt?:boolean}}
 *
 * `countAttempt` tells the caller to increment `attempts`; `burn` tells it to
 * kill the challenge outright. They are returned rather than applied because
 * this function does no I/O.
 */
function verifyChallenge(row, input, now = new Date()) {
    const { code, machineId } = input || {};

    // An unknown id and a consumed one are reported identically: telling the
    // caller which is which would confirm that a given challenge_id once
    // existed.
    if (!row) {
        return { ok: false, reason: 'not_found', message: 'This code is no longer valid. Start again.' };
    }
    if (row.consumed_at) {
        return { ok: false, reason: 'consumed', message: 'This code is no longer valid. Start again.' };
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired', message: 'This code has expired. Send a new one.' };
    }
    if (Number(row.attempts) >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'locked', burn: true, message: 'Too many attempts. Start again.' };
    }

    // Machine binding. Checked BEFORE the code so a code obtained on one PC is
    // useless on another even if the attacker knows it.
    if (String(row.machine_id) !== String(machineId || '')) {
        return {
            ok: false, reason: 'machine_mismatch', burn: true,
            message: 'This code was requested on a different computer. Start again here.',
        };
    }

    if (!hashesEqual(row.code_hash, hashCode(code))) {
        const attemptsLeft = Math.max(0, MAX_ATTEMPTS - (Number(row.attempts) + 1));
        return {
            ok: false, reason: 'wrong_code', countAttempt: true, attemptsLeft,
            message: attemptsLeft > 0
                ? `That code is not right. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
                : 'Too many attempts. Start again.',
            burn: attemptsLeft === 0,
        };
    }

    return { ok: true, reason: 'verified' };
}

/**
 * Decide whether a resend is allowed right now.
 *
 * @returns {{ok:boolean, reason?:string, message?:string, retryInSeconds?:number}}
 */
function canResend(row, now = new Date()) {
    if (!row || row.consumed_at) {
        return { ok: false, reason: 'not_found', message: 'This code is no longer valid. Start again.' };
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired', message: 'This code has expired. Start again.' };
    }
    if (Number(row.resends) >= MAX_RESENDS) {
        return { ok: false, reason: 'resend_cap', message: 'Too many codes sent. Start again.' };
    }
    const last = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
    const waited = now.getTime() - last;
    if (waited < RESEND_COOLDOWN_MS) {
        const retryInSeconds = Math.ceil((RESEND_COOLDOWN_MS - waited) / 1000);
        return {
            ok: false, reason: 'cooldown', retryInSeconds,
            message: `Wait ${retryInSeconds}s before asking for another code.`,
        };
    }
    return { ok: true };
}

module.exports = {
    CODE_TTL_MS,
    MAX_ATTEMPTS,
    RESEND_COOLDOWN_MS,
    MAX_RESENDS,
    generateCode,
    hashCode,
    hashesEqual,
    maskEmail,
    buildChallenge,
    verifyChallenge,
    canResend,
};
