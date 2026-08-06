'use strict';

/**
 * api/Helpers/throttle.js
 *
 * A fixed-window counter, used to slow down guessing on the agent sign-in
 * endpoints. Deliberately tiny: no dependency, no Redis, no table.
 *
 * SCOPE AND ITS LIMIT — read before reusing this.
 *
 * State lives in this process's memory. That is correct for the current
 * deployment (ecosystem.config.js runs the API as a SINGLE fork-mode instance),
 * where one process sees every request. It stops being correct the moment the
 * API is clustered or run behind more than one host: each worker would keep its
 * own counter, so the effective limit multiplies by the worker count. If that
 * day comes, move the store to the database or Redis — the interface here
 * (`hit`/`reset`) is small enough that only this file changes.
 *
 * It also resets on deploy, which hands an attacker a fresh budget. That is
 * tolerable for the LOGIN throttle, where the attacker still has to know a
 * password. It is NOT tolerable for the OTP attempt cap, which is why that one
 * is a column on `agent_otp_challenges` rather than a counter here.
 */

// key -> { count, resetAt }
const buckets = new Map();

// Bound the map so a flood of unique keys (one per spoofed IP) cannot grow it
// without limit. When exceeded, the whole map is dropped: every counter resets,
// which is worse for accuracy but better than exhausting memory — and expired
// entries are the overwhelming majority of what is discarded.
const MAX_KEYS = 50_000;

function sweep(now) {
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

/**
 * Record one attempt against `key` and report whether it is allowed.
 *
 * @param {string} key          e.g. `login:email:a@b.com`
 * @param {number} limit        attempts permitted per window
 * @param {number} windowMs     window length
 * @param {number} [now]        injectable clock, for tests
 * @returns {{allowed:boolean, remaining:number, retryAfterSeconds:number}}
 */
function hit(key, limit, windowMs, now = Date.now()) {
    if (buckets.size > MAX_KEYS) {
        sweep(now);
        if (buckets.size > MAX_KEYS) buckets.clear();
    }

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
    }

    existing.count += 1;
    // Counting past the limit is intentional: it does not change the verdict,
    // but it means a caller that keeps hammering does not silently roll into a
    // new window early.
    const allowed = existing.count <= limit;
    return {
        allowed,
        remaining: Math.max(0, limit - existing.count),
        retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
    };
}

/** Clear one key — called after a SUCCESSFUL sign-in so a legitimate user who
 *  fumbled their password a few times is not left throttled. */
function reset(key) {
    buckets.delete(key);
}

/** Test-only: drop all state. */
function _clearAll() {
    buckets.clear();
}

module.exports = { hit, reset, _clearAll };
