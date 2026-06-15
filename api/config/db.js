'use strict';

/**
 * api/config/db.js
 *
 * The ONE shared Knex instance for the whole process. TallySaaS is a single
 * PostgreSQL database with row-level multi-tenancy (`company_id` on every
 * tenant table), so — unlike the IOT reference's master/tenant split — there
 * is a single pool here and no on-demand per-tenant connections.
 *
 * Exports:
 *   db              — the Knex instance (require this everywhere you need DB).
 *   ping()          — one-shot connectivity check (resolves on success).
 *   pingWithRetry() — boot-time retry-with-backoff for slow/racy DB startup.
 *
 * The active environment is picked from APP_ENV via knexfile.js.
 */

const knex     = require('knex');
const knexfile = require('../knexfile');

const ENV = process.env.APP_ENV || 'development';

// Single shared Knex instance for the whole process.
const db = knex(knexfile[ENV] || knexfile.development);

/**
 * Lightweight connectivity check. Resolves on success; rejects with the
 * underlying pg error on failure (the caller decides whether to log and
 * keep serving DB-less endpoints, or exit). Used by /health and at boot.
 */
async function ping() {
    await db.raw('SELECT 1');
}

/**
 * Retry-with-backoff variant — useful at app boot when PG might still be
 * coming up (docker-compose ordering, k8s init containers). Pings every
 * `baseDelayMs * 2^attempt` until it either succeeds or exhausts
 * `maxAttempts`. Resolves with the number of attempts taken; rejects with
 * the LAST pg error if it never connects.
 *
 *   await pingWithRetry({ maxAttempts: 5, baseDelayMs: 500 });
 *
 * Tolerant of the two failure modes ops actually hit:
 *   • ECONNREFUSED                          (PG not listening yet)
 *   • "the database system is starting up"  (PG up, still recovering)
 */
async function pingWithRetry(opts = {}) {
    const maxAttempts = Number(opts.maxAttempts) >= 1 ? Number(opts.maxAttempts) : 5;
    const baseDelayMs = Number(opts.baseDelayMs) >= 1 ? Number(opts.baseDelayMs) : 500;
    const onAttempt   = typeof opts.onAttempt === 'function' ? opts.onAttempt : () => {};
    // Test seam — callers can inject a stub probe instead of the real db.raw,
    // letting tests verify the retry/backoff logic without a live DB.
    const probe       = typeof opts._probe === 'function' ? opts._probe : ping;

    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await probe();
            return attempt + 1;
        } catch (err) {
            lastErr = err;
            onAttempt({ attempt: attempt + 1, err });
            if (attempt + 1 >= maxAttempts) break;
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

module.exports = { db, ping, pingWithRetry };
