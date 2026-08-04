'use strict';

/**
 * api/db/provision.js
 *
 * Provisioning for the per-license multi-DB model (see memory: per-license-db-split).
 * Adapted from the IOT reference's scripts/provision-company.js — but per-LICENSE.
 *
 *   • setupMaster()               — create the MASTER db (tallysaas_master), apply
 *                                   master-schema.sql, seed the permission catalogue
 *                                   + the platform super-admin user. Idempotent.
 *   • provisionLicense(opts)      — create a license (master) + its OWN tenant db
 *                                   `tally_lic_<id>`, apply tenant-schema.sql, seed
 *                                   RBAC + a default company + the license-admin user
 *                                   (in MASTER for auth, MIRRORED into the tenant with
 *                                   the SAME id for business-data FKs). Idempotent-ish.
 *
 * Auth model: master.users is the login source (email/password/license_id/role_slug,
 * role_id nullable). Permission resolution happens in the tenant (users mirror →
 * role_id → role_permissions). Super-admin (license_id NULL, no tenant) bypasses.
 *
 * CLI:
 *   node db/provision.js setup-master
 *   node db/provision.js license --holder "Acme" --email admin@acme.com [--password X] [--name "Acme Admin"]
 */

require('dotenv').config();

const path       = require('path');
const fs         = require('fs');
const knexLib    = require('knex');
const { Client } = require('pg');

const passwords  = require('../Helpers/passwords');
const licenseKey = require('../Helpers/licenseKey');
const keyCrypto  = require('../Helpers/keyCrypto');
const { migrateTenant } = require('./migrate-tenants');

const MASTER_DB    = String(process.env.MASTER_DB_DATABASE || 'tallysaas_master');
const DB_NAME_RE   = /^[a-z_][a-z0-9_]{0,62}$/i;
const NOOP         = () => {};

// ── Canonical RBAC catalogue (23 modules × 5 actions). Both master + every
//    tenant seed from this ONE list so the catalogue never drifts. ──
const MODULES = [
    'dashboard', 'companies', 'locations', 'sales-persons', 'customers', 'suppliers',
    'products', 'categories', 'sales-invoices', 'purchase-invoices', 'payments',
    'receipts', 'expenses', 'inventory', 'tally-sync', 'reports', 'users', 'settings',
    'einvoice', 'recurring-invoices', 'bank-reconciliation', 'field-sales', 'gps-tracking',
    'customer-users', 'website-users',
    // ── menu-driven modules (4 Aug 2026) — हर sidebar item का अपना module ──
    'journals', 'cash-bank', 'receivables', 'payables', 'accountant', 'roles',
    // ── अभी-न-बने ("Soon") modules — entitlement पहले से तैयार ──
    'quotations', 'sales-orders', 'purchase-orders', 'delivery-notes', 'receipt-notes',
    'credit-notes', 'debit-notes', 'contra', 'stock-journal', 'physical-stock',
    'collect-payments', 'gst-search', 'data-backup',
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
// Built-in system roles. Only these two are seeded; a company creates its own
// custom roles later. Both get ALL permissions on every module.
const SYSTEM_ROLES = [
    { name: 'Super Admin',   slug: 'super-admin' },
    { name: 'Company Admin', slug: 'company-admin' },
];

// ── low-level helpers ────────────────────────────────────────
function baseConn() {
    return {
        host    : process.env.DB_HOST     || '127.0.0.1',
        port    : parseInt(process.env.DB_PORT, 10) || 5432,
        user    : process.env.DB_USERNAME || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
    };
}
function adminClient() { return new Client({ ...baseConn(), database: 'postgres' }); }
function makeKnex(dbName) {
    return knexLib({ client: 'pg', connection: { ...baseConn(), database: dbName }, pool: { min: 1, max: 3 } });
}
function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
}

async function ensureDatabase(dbName) {
    if (!DB_NAME_RE.test(dbName)) throw new Error(`refusing unsafe db_name "${dbName}"`);
    const admin = adminClient();
    await admin.connect();
    try {
        const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (r.rowCount > 0) return false;
        await admin.query(`CREATE DATABASE "${dbName}"`);
        return true;
    } finally { await admin.end(); }
}

// Drop a tenant db if it exists (terminating any live connections first). Used
// when provisioning a FRESH licence: its `tally_lic_<id>` must start empty. A
// same-named db here is always STALE — the master was reset (e.g. re-run knex
// migrate) so a new licence reused an id whose old tenant db was left behind;
// reusing it would collide (duplicate company/user ids). Safe: the licence id is
// freshly minted, so no LIVE tenant can legitimately own this db yet.
async function dropDatabaseIfExists(dbName) {
    if (!DB_NAME_RE.test(dbName)) throw new Error(`refusing unsafe db_name "${dbName}"`);
    const admin = adminClient();
    await admin.connect();
    try {
        await admin.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [dbName],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally { await admin.end(); }
}

async function runSchemaFile(knex, file) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    await knex.raw(sql);
}

// Seed the permission catalogue into a db (master OR tenant). Returns slug→id map.
async function seedPermissions(knex) {
    const permIdBySlug = {};
    for (const mod of MODULES) {
        for (const action of ACTIONS) {
            const slug = `${mod}.${action}`;
            let row = await knex('permissions').where('slug', slug).first('id');
            if (!row) [row] = await knex('permissions').insert({ module: mod, action, slug }).returning('id');
            permIdBySlug[slug] = row.id;
        }
    }
    return permIdBySlug;
}

// Seed system roles + grant ALL perms to both. Returns slug→roleId map.
async function seedRoles(knex, permIdBySlug) {
    const roleIdBySlug = {};
    for (const role of SYSTEM_ROLES) {
        let row = await knex('roles').whereNull('company_id').andWhere('slug', role.slug).first('id');
        if (!row) [row] = await knex('roles').insert({ company_id: null, name: role.name, slug: role.slug, is_system: true }).returning('id');
        roleIdBySlug[role.slug] = row.id;
        for (const slug of Object.keys(permIdBySlug)) {
            await knex('role_permissions')
                .insert({ role_id: row.id, permission_id: permIdBySlug[slug] })
                .onConflict(['role_id', 'permission_id']).ignore();
        }
    }
    return roleIdBySlug;
}

// ── MASTER setup ─────────────────────────────────────────────
async function setupMaster(ctx = {}) {
    const log = ctx.log || NOOP;
    const dbCreated = await ensureDatabase(MASTER_DB);
    log(dbCreated ? `✓ created master db "${MASTER_DB}"` : `✓ master db "${MASTER_DB}" exists`);

    const m = makeKnex(MASTER_DB);
    try {
        // Only apply the schema on a fresh db (knex_migrations table absent).
        const has = await m.schema.hasTable('users');
        if (!has) {
            await runSchemaFile(m, 'master-schema.sql');
            log('✓ applied master-schema.sql');
        }
        // Master.users is the auth source: role_id references a TENANT role (plain
        // int, no FK) so it must be nullable (super-admin has no tenant), and we
        // denormalise role_slug so login needn't touch a tenant db.
        await m.raw('ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL').catch(() => {});
        await m.raw("ALTER TABLE users ADD COLUMN IF NOT EXISTS role_slug varchar(64)").catch(() => {});
        await m.raw("ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS platform varchar(16)").catch(() => {});
        await m.raw("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS sync_push_modules text").catch(() => {});
        await m.raw("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS sync_pull_modules text").catch(() => {});

        const permIdBySlug = await seedPermissions(m);
        log(`✓ master permissions: ${Object.keys(permIdBySlug).length}`);

        // Platform super-admin (no license, no tenant → role_id NULL, slug drives bypass).
        const email = 'admin@tallysaas.test';
        const exists = await m('users').whereRaw('lower(email) = ?', [email]).first('id');
        if (!exists) {
            const hash = await passwords.hash('Admin@123');
            const [u] = await m('users').insert({
                name: 'Super Admin', email, password_hash: hash, role_id: null, role_slug: 'super-admin',
                company_id: null, license_id: null, status: 'Active', approval_status: 'approved',
            }).returning('id');
            log(`✓ master super-admin user id=${u.id} <${email}> (password Admin@123)`);
        } else {
            log(`✓ master super-admin <${email}> exists`);
        }
    } finally { await m.destroy(); }
}

// ── provision one LICENSE + its tenant db ────────────────────
async function provisionLicense(opts, ctx = {}) {
    const log = ctx.log || NOOP;
    const holder   = String(opts.holderName || opts.holder || '').trim();
    const email    = String(opts.adminEmail || opts.email || '').trim().toLowerCase();
    const adminName = String(opts.adminName || holder).trim();
    const password = String(opts.adminPassword || opts.password || '').trim() || `Tally@${Math.floor(1000 + Math.random() * 8999)}`;
    if (!holder) throw new Error('holderName is required.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error(`invalid adminEmail "${email}".`);

    const m = makeKnex(MASTER_DB);
    try {
        const dup = await m('users').whereRaw('lower(email) = ?', [email]).first('id');
        if (dup) throw new Error(`a user with email "${email}" already exists in master.`);

        // 1) license row in MASTER
        const { key, prefix, hash } = licenseKey.generate();
        const [lic] = await m('licenses').insert({
            license_key_hash: hash,
            license_key_enc:  keyCrypto.encryptKey(key),
            key_prefix:       prefix,
            holder_name:      holder,
            plan:             opts.plan || 'standard',
            max_companies:    opts.maxCompanies != null ? opts.maxCompanies : 5,
            max_users:        opts.maxUsers != null ? opts.maxUsers : 10,
            valid_until:      opts.validUntil || null,
            status:           'active',
            sync_push_enabled: false,
        }).returning('*');
        const dbName = `tally_lic_${lic.id}`;
        log(`✓ master license id=${lic.id} holder="${holder}" key=${key}`);

        // 2) FRESH tenant db — drop any stale same-named db (a reused id after a
        //    master reset) so provisioning always starts clean, then create.
        await dropDatabaseIfExists(dbName);
        await ensureDatabase(dbName);
        log(`✓ created tenant db "${dbName}" (fresh)`);
        const t = makeKnex(dbName);
        let masterUserId;
        try {
            if (!(await t.schema.hasTable('companies'))) {
                await runSchemaFile(t, 'tenant-schema.sql');
                log('✓ applied tenant-schema.sql');
            }
            // Bring the fresh tenant up to the CURRENT schema. tenant-schema.sql is
            // the baseline; everything added since lives in db/migrations_tenant/
            // (each migration is guarded, so re-stating a baseline object no-ops).
            // Without this a new licence would be born older than the fleet.
            await migrateTenant(t, { log: (s) => log(s.trim()) });
            // 3) tenant RBAC — NO default company. Companies come from the Tally
            //    sync (agent importFromTally find-or-create) or a manual "Add
            //    Company", so a fresh licence starts with ZERO companies. Creating
            //    a "<holder>" placeholder here made a DUPLICATE sit beside the real
            //    Tally company (their names rarely match), which is what the
            //    operator saw as "why are there 2 companies?".
            const permIdBySlug = await seedPermissions(t);
            const roleIdBySlug = await seedRoles(t, permIdBySlug);
            const companyAdminRoleId = roleIdBySlug['company-admin'];
            log(`✓ tenant RBAC (${Object.keys(permIdBySlug).length} perms, ${Object.keys(roleIdBySlug).length} roles) — no default company`);

            // 4) admin user in MASTER (auth) — role_id = the TENANT company-admin role id.
            const pwHash = await passwords.hash(password);
            const [mu] = await m('users').insert({
                name: adminName, email, password_hash: pwHash,
                role_id: companyAdminRoleId, role_slug: 'company-admin',
                company_id: null, license_id: lic.id, status: 'Active', approval_status: 'approved',
            }).returning('id');
            masterUserId = mu.id;

            // 5) MIRROR the user into the tenant with the SAME id (business FKs).
            //    company_id: null — a licence-admin operates across the licence's
            //    companies via the switcher (X-Company-Id), not a pinned company;
            //    there is no default company to pin to anyway.
            await t('users').insert({
                id: masterUserId, name: adminName, email, password_hash: pwHash,
                role_id: companyAdminRoleId, company_id: null, license_id: lic.id,
                status: 'Active', approval_status: 'approved',
            });
            // keep the tenant users sequence past the explicit id.
            await t.raw("SELECT setval(pg_get_serial_sequence('users','id'), (SELECT COALESCE(MAX(id),1) FROM users))");

            // 6) SEAT — an active subscription (master) so the login seat-gate
            // passes. valid_until tracks the licence (or +10y when it never expires).
            const validUntil = opts.validUntil
                ? new Date(opts.validUntil)
                : new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
            await m('subscriptions').insert({
                user_id: masterUserId, plan: opts.plan || 'standard',
                valid_from: new Date(), valid_until: validUntil, status: 'active',
            });
            log(`✓ admin user id=${masterUserId} <${email}> (master auth + tenant mirror + active seat) password=${password}`);
        } catch (err) {
            // Cross-DB partial failure → roll the master rows back (leave NO orphan
            // licence / admin / seat) and drop the half-built tenant db, then
            // rethrow the original error so the caller reports the real cause.
            await m('subscriptions').where('user_id', masterUserId || -1).del().catch(() => {});
            await m('users').where('license_id', lic.id).del().catch(() => {});
            await m('licenses').where('id', lic.id).del().catch(() => {});
            await t.destroy().catch(() => {});
            await dropDatabaseIfExists(dbName).catch(() => {});
            throw err;
        } finally { await t.destroy().catch(() => {}); }

        return { license: lic, dbName, adminEmail: email, adminPassword: password, licenseKey: key, adminUserId: masterUserId };
    } finally { await m.destroy(); }
}

module.exports = {
    setupMaster, provisionLicense, MASTER_DB, ensureDatabase, makeKnex,
    // Exposed so the knex master migration/seed reuse the SAME schema + catalogue
    // (one source of truth — knex-migrate and provision.js produce identical masters).
    seedPermissions, seedRoles, MODULES, ACTIONS, SYSTEM_ROLES,
};

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const args = {};
    for (let i = 1; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
    }
    (async () => {
        if (cmd === 'setup-master') {
            await setupMaster({ log: console.log });
        } else if (cmd === 'license') {
            const r = await provisionLicense({
                holderName: args.holder, adminEmail: args.email, adminPassword: args.password, adminName: args.name,
            }, { log: console.log });
            console.log(`\n✓ Done. Licence "${r.license.holder_name}" (id=${r.license.id}) → db=${r.dbName}`);
            console.log(`  admin: ${r.adminEmail} / ${r.adminPassword}`);
            console.log(`  key  : ${r.licenseKey}`);
        } else {
            console.log('Usage:\n  node db/provision.js setup-master\n  node db/provision.js license --holder "Acme" --email a@b.c [--password X] [--name "Acme Admin"]');
        }
        process.exit(0);
    })().catch((e) => { console.error('✗ provision failed:', e.message); process.exit(1); });
}
