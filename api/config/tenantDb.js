'use strict';

/**
 * api/config/tenantDb.js
 *
 * Lazy-cached Knex connection factory for per-LICENSE tenant databases.
 * (Adapted from the IOT reference's per-company `config/tenant-db.js`.)
 *
 *   const tenant = require('./config/tenantDb');
 *   const db = tenant.getTenantKnex('tally_lic_1');   // Knex instance
 *   await db('invoices').where('id', x).first();
 *
 * Multi-DB model (Phase: per-license split):
 *   • MASTER db  (config/db.js → tallysaas_master) holds ONLY the control
 *     plane: licenses, users (auth), permissions catalogue, entitlements,
 *     sessions, platform settings + the license→db_name directory.
 *   • Each LICENSE gets its OWN database `tally_lic_<id>` holding companies,
 *     roles and ALL business data (customers, invoices, products, field …).
 *
 * Tenant pools are created on first request and reused for the process
 * lifetime. Each pool is small (min 1, max 5) to keep connection pressure
 * manageable when many licences are active at once.
 *
 * Identifier safety: the db name must pass DB_NAME_RE before we ever open a
 * pool to it — defence-in-depth even though db_name only ever comes from the
 * provision flow / the signed JWT.
 *
 * Credential safety: each pool logs in as that licence's OWN PostgreSQL role
 * (config/tenantCredentials → Helpers/tenantRoles), which can CONNECT to this
 * one database only. Connecting every tenant as the shared cluster superuser —
 * what this file used to do — meant a single injected query in licence 1 could
 * reach licence 2's data through dblink/COPY, making the per-database split
 * cosmetic. Licences not yet migrated fall back to the admin login unless
 * TENANT_DB_STRICT_ROLES=true.
 */

const knex = require('knex');

const credentials = require('./tenantCredentials');
const { withSsl } = require('./pgSsl');

const DB_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

// The tenant DB name for a licence id. Numeric-id based (licences have stable
// integer ids) so it is always unique + regex-safe.
function dbNameForLicense(licenseId) {
    return `tally_lic_${Number(licenseId)}`;
}

// dbName → Knex instance. Process-local, reused across requests.
const pools = new Map();

/**
 * Return the (cached) Knex instance for a given tenant DB name.
 * @param {string} dbName  e.g. "tally_lic_1"
 * @returns {import('knex').Knex}
 */
function getTenantKnex(dbName) {
    if (!dbName || typeof dbName !== 'string') {
        throw new TypeError('getTenantKnex(dbName) requires a non-empty string.');
    }
    if (!DB_NAME_RE.test(dbName)) {
        throw new Error(`Refusing to connect to unsafe db_name "${dbName}".`);
    }
    const cached = pools.get(dbName);
    if (cached) return cached;

    // Throws in strict mode when this licence has no dedicated role yet — we
    // fail closed rather than silently opening a superuser pool.
    const cred = credentials.get(dbName);

    const inst = knex({
        client: 'pg',
        connection: {
            host    : String(process.env.DB_HOST     || '127.0.0.1'),
            port    : parseInt(process.env.DB_PORT, 10) || 5432,
            user    : cred.user,
            password: cred.password,
            database: dbName,
            ...withSsl(),
        },
        pool: {
            min: 1,
            max: 5,
            // Pin to IST so now() + every TIMESTAMPTZ read reports local time
            // (matches the single-DB knexfile the app used before the split).
            afterCreate: (conn, done) => {
                conn.query("SET timezone = 'Asia/Kolkata';", (err) => done(err, conn));
            },
        },
    });
    pools.set(dbName, inst);
    return inst;
}

/** Cached Knex for a licence id (convenience over getTenantKnex). */
function getKnexForLicense(licenseId) {
    return getTenantKnex(dbNameForLicense(licenseId));
}

/** How many tenant pools are held (ops/health). */
function size() { return pools.size; }

/** Whether a db name has a live pool (without creating one). */
function has(dbName) { return pools.has(dbName); }

/** Destroy every cached pool (graceful shutdown). */
async function closeAll() {
    for (const inst of pools.values()) {
        try { await inst.destroy(); } catch (e) { console.error('tenantDb: closeAll error:', e.message); }
    }
    pools.clear();
}

/**
 * Destroy + forget a single pool, so the next call reconnects (a rotated role
 * password, a dropped licence).
 *
 * `forgetCredentials` defaults to FALSE on purpose: dropping the cached role
 * would make the next connection fall back to the shared admin login in
 * non-strict mode. Pass true only when the licence itself is going away.
 */
async function evict(dbName, { forgetCredentials = false } = {}) {
    if (forgetCredentials) credentials.forget(dbName);
    const inst = pools.get(dbName);
    if (!inst) return false;
    pools.delete(dbName);
    try { await inst.destroy(); } catch (e) { console.error(`tenantDb: evict "${dbName}" error:`, e.message); }
    return true;
}

module.exports = {
    DB_NAME_RE,
    dbNameForLicense,
    getTenantKnex,
    getKnexForLicense,
    size,
    has,
    closeAll,
    evict,
};
