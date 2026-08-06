'use strict';

/**
 * api/db/migrate-tenants.js
 *
 * Knex migration runner for the per-LICENCE tenant databases.
 *
 * Until now tenant dbs were only ever built once, from db/tenant-schema.sql at
 * provision time (see provision.js) — there was NO way to evolve the schema of a
 * licence that already existed. Every Tally-coverage change (new master tables,
 * new voucher child tables, GUID/MASTERID columns) needs exactly that, so tenant
 * dbs now carry their own migration history.
 *
 * Two schema sources, one end state:
 *   • FRESH tenant  → tenant-schema.sql, then every migration (each guarded with
 *     IF NOT EXISTS / hasTable, so re-stating something the sql already made is
 *     a no-op) — provision.js calls migrateTenant() right after the sql.
 *   • EXISTING tenant → `npm run migrate:tenants` walks master.licenses and runs
 *     the pending migrations on each `tally_lic_<id>`.
 *
 * Migrations live in db/migrations_tenant/ and are tracked in the tenant's own
 * `knex_migrations_tenant` table — deliberately a different table name from the
 * master's `knex_migrations` so the two histories can never be confused.
 *
 * CLI:
 *   node db/migrate-tenants.js latest              # all licences
 *   node db/migrate-tenants.js latest --license 3  # one licence
 *   node db/migrate-tenants.js rollback [--license 3]
 *   node db/migrate-tenants.js status
 */

require('dotenv').config();

const path    = require('path');
const knexLib = require('knex');
const { Client } = require('pg');

const MASTER_DB  = String(process.env.MASTER_DB_DATABASE || 'tallysaas_master');
const DB_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/i;
const NOOP       = () => {};

const MIGRATION_CONFIG = {
    directory: path.join(__dirname, 'migrations_tenant'),
    tableName: 'knex_migrations_tenant',
};

function baseConn() {
    return {
        host    : process.env.DB_HOST     || '127.0.0.1',
        port    : parseInt(process.env.DB_PORT, 10) || 5432,
        user    : process.env.DB_USERNAME || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
    };
}

/** A short-lived Knex bound to one tenant db, pre-wired with the tenant migration config. */
function tenantKnex(dbName) {
    if (!DB_NAME_RE.test(dbName)) throw new Error(`refusing unsafe db_name "${dbName}"`);
    return knexLib({
        client    : 'pg',
        connection: { ...baseConn(), database: dbName },
        pool      : { min: 1, max: 2 },
        migrations: MIGRATION_CONFIG,
    });
}

/** True when the physical database exists (a licence row can outlive its db). */
async function databaseExists(dbName) {
    const admin = new Client({ ...baseConn(), database: 'postgres' });
    await admin.connect();
    try {
        const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        return r.rowCount > 0;
    } finally { await admin.end(); }
}

/**
 * Every tenant db name we know about, in licence-id order.
 * Reads master.licenses directly (not config/tenantDb) so this runs standalone.
 */
async function listTenantDbs({ licenseId = null } = {}) {
    const m = knexLib({ client: 'pg', connection: { ...baseConn(), database: MASTER_DB }, pool: { min: 1, max: 2 } });
    try {
        const q = m('licenses').select('id', 'holder_name').orderBy('id', 'asc');
        if (licenseId != null) q.where('id', Number(licenseId));
        const rows = await q;
        return rows.map((r) => ({ licenseId: r.id, holder: r.holder_name, dbName: `tally_lic_${r.id}` }));
    } finally { await m.destroy(); }
}

/**
 * Run pending tenant migrations against ONE db. Accepts an existing Knex
 * instance (provision.js already holds one) or a db name.
 * @returns {Promise<string[]>} filenames applied
 */
async function migrateTenant(knexOrDbName, ctx = {}) {
    const log = ctx.log || NOOP;
    const own = typeof knexOrDbName === 'string';
    const k   = own ? tenantKnex(knexOrDbName) : knexOrDbName;
    try {
        // A caller-supplied Knex (provision.js) has no tenant migration config of
        // its own, so pass it explicitly — knex merges it over the instance config.
        const [batch, applied] = await k.migrate.latest(MIGRATION_CONFIG);
        if (applied.length) log(`  ✓ batch ${batch}: ${applied.length} migration(s)`);
        else log('  ✓ already up to date');
        for (const f of applied) log(`      · ${path.basename(f)}`);
        return applied;
    } finally { if (own) await k.destroy().catch(() => {}); }
}

/** Roll back the last batch on ONE tenant db. */
async function rollbackTenant(dbName, ctx = {}) {
    const log = ctx.log || NOOP;
    const k = tenantKnex(dbName);
    try {
        const [batch, reverted] = await k.migrate.rollback(MIGRATION_CONFIG);
        log(reverted.length ? `  ✓ rolled back batch ${batch}: ${reverted.length}` : '  ✓ nothing to roll back');
        return reverted;
    } finally { await k.destroy().catch(() => {}); }
}

/** Applied / pending counts for ONE tenant db. */
async function statusTenant(dbName) {
    const k = tenantKnex(dbName);
    try {
        const [applied, pending] = await k.migrate.list(MIGRATION_CONFIG);
        return { applied: applied.length, pending: pending.map((p) => (p.file || p)) };
    } finally { await k.destroy().catch(() => {}); }
}

/**
 * Apply pending migrations across EVERY licence (or one with `licenseId`).
 * A failure on one tenant is recorded and the walk continues — one broken
 * licence db must not block the rest of the fleet from being upgraded.
 */
async function migrateAllTenants({ licenseId = null, log = NOOP } = {}) {
    const targets = await listTenantDbs({ licenseId });
    const results = [];
    for (const t of targets) {
        log(`\n→ licence ${t.licenseId} "${t.holder}" (${t.dbName})`);
        if (!(await databaseExists(t.dbName))) {
            log('  · skipped — database does not exist');
            results.push({ ...t, skipped: true });
            continue;
        }
        try {
            const applied = await migrateTenant(t.dbName, { log });
            results.push({ ...t, applied });
        } catch (err) {
            log(`  ✗ FAILED: ${err.message}`);
            results.push({ ...t, error: err.message });
        }
    }
    return results;
}

module.exports = {
    MIGRATION_CONFIG,
    tenantKnex,
    listTenantDbs,
    databaseExists,
    migrateTenant,
    rollbackTenant,
    statusTenant,
    migrateAllTenants,
};

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
    const argv = process.argv.slice(2);
    const cmd  = argv[0] || 'latest';
    const args = {};
    for (let i = 1; i < argv.length; i++) {
        if (argv[i].startsWith('--')) args[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
    const licenseId = args.license != null && args.license !== true ? Number(args.license) : null;

    (async () => {
        if (cmd === 'latest') {
            const res = await migrateAllTenants({ licenseId, log: console.log });
            const failed = res.filter((r) => r.error);
            console.log(`\n✓ ${res.length - failed.length}/${res.length} tenant db(s) up to date`);
            if (failed.length) { failed.forEach((f) => console.error(`  ✗ ${f.dbName}: ${f.error}`)); process.exit(1); }
        } else if (cmd === 'rollback') {
            for (const t of await listTenantDbs({ licenseId })) {
                console.log(`\n→ ${t.dbName}`);
                if (!(await databaseExists(t.dbName))) { console.log('  · skipped — no database'); continue; }
                await rollbackTenant(t.dbName, { log: console.log }).catch((e) => console.error(`  ✗ ${e.message}`));
            }
        } else if (cmd === 'status') {
            for (const t of await listTenantDbs({ licenseId })) {
                if (!(await databaseExists(t.dbName))) { console.log(`${t.dbName}: (no database)`); continue; }
                const s = await statusTenant(t.dbName).catch((e) => ({ error: e.message }));
                if (s.error) console.log(`${t.dbName}: ✗ ${s.error}`);
                else console.log(`${t.dbName}: ${s.applied} applied, ${s.pending.length} pending${s.pending.length ? ' → ' + s.pending.join(', ') : ''}`);
            }
        } else {
            console.log('Usage:\n  node db/migrate-tenants.js latest   [--license N]\n  node db/migrate-tenants.js rollback [--license N]\n  node db/migrate-tenants.js status   [--license N]');
        }
        process.exit(0);
    })().catch((e) => { console.error('✗ tenant migrate failed:', e.message); process.exit(1); });
}
