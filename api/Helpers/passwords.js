'use strict';

/**
 * api/Helpers/passwords.js
 *
 * Forward-compatible password hasher + verifier. NEW hashes use argon2id
 * (RFC 9106, winner of the Password Hashing Competition). EXISTING bcrypt
 * hashes still verify so an imported/legacy user is never locked out by the
 * rollout.
 *
 *   await hash('hunter2')            → '$argon2id$...'
 *   await verify('hunter2', stored)  → true | false
 *   needsRehash(stored)              → true when stored is bcrypt (or argon2
 *                                      params are stale) — caller should
 *                                      re-hash + update the row on a
 *                                      successful login ("lazy migrate on
 *                                      next login").
 *
 * Always go through these helpers so fresh passwords are never written with
 * bcrypt.
 *
 * Reference: https://github.com/P-H-C/phc-winner-argon2
 */

const bcrypt = require('bcryptjs');
const argon2 = require('argon2');

// Conservative argon2id parameters — strong without making login a noticeable
// hangup on commodity Node hosts (same order of magnitude as the OWASP
// "interactive login" recommendation):
//   memory      = 64 MiB
//   iterations  = 3
//   parallelism = 1
const ARGON_OPTS = {
    type:        argon2.argon2id,
    memoryCost:  64 * 1024,
    timeCost:    3,
    parallelism: 1,
};

function isArgon(stored) {
    return typeof stored === 'string' && stored.startsWith('$argon2');
}
function isBcrypt(stored) {
    return typeof stored === 'string' && /^\$2[abxy]\$/.test(stored);
}

async function hash(password) {
    if (password == null) throw new TypeError('hash(password) requires a string.');
    return argon2.hash(String(password), ARGON_OPTS);
}

async function verify(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    try {
        if (isArgon(stored)) {
            return await argon2.verify(stored, String(password));
        }
        if (isBcrypt(stored)) {
            return await bcrypt.compare(String(password), stored);
        }
        return false;
    } catch {
        // argon2/bcrypt throw on malformed hashes; treat as a failed verify.
        return false;
    }
}

function needsRehash(stored) {
    // True when the stored hash is on the legacy algorithm OR when argon2's
    // own needsRehash says the params are out of date. Callers that just hit
    // a successful verify should re-hash + update.
    if (!stored || typeof stored !== 'string') return true;
    if (isBcrypt(stored)) return true;
    if (isArgon(stored)) {
        try { return argon2.needsRehash(stored, ARGON_OPTS); }
        catch { return true; }
    }
    return true;
}

module.exports = {
    hash, verify, needsRehash,
    isArgon, isBcrypt,
    ARGON_OPTS,
};
