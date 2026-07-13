'use strict';

/**
 * 20260706120000_master_control_plane.js
 *
 * THE master control-plane schema. Since the per-license DB split, `knex
 * migrate:latest` runs against the MASTER database (DB_DATABASE=tallysaas_master)
 * and must create ONLY the 11 master-plane tables — NOT the business tables
 * (those live in each licence's own `tally_lic_<id>` db, created by
 * db/provision.js when a licence is provisioned).
 *
 * The 68 original single-DB migrations (which created all ~64 tables in one db)
 * are archived under db/migrations_legacy_presplit/ — running them here is what
 * wrongly filled master with every table.
 *
 * This migration applies db/master-schema.sql (the SAME generated file
 * provision.js uses, so knex-migrate and provision.js produce an identical
 * master) + the two auth tweaks: master.users.role_id is nullable (it points at
 * a TENANT role by plain int) and carries a denormalised role_slug so login
 * never has to touch a tenant db.
 *
 * Tenant schema is NOT applied here — see db/tenant-schema.sql + provision.js.
 */

const fs = require('fs');
const path = require('path');
// Reuse the SAME permission catalogue provision.js uses, so knex-migrate and
// provision.js seed an identical master (one source of truth).
const { seedPermissions } = require('../provision');
const passwords = require('../../Helpers/passwords');

// Platform super-admin seeded on a fresh master (override via env if desired).
const SUPER_ADMIN_EMAIL    = (process.env.SUPER_ADMIN_EMAIL || 'admin@tallysaas.test').trim();
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Admin@123';

// The 11 master tables, dependents first (CASCADE covers the rest) — for down().
const MASTER_TABLES = [
    'user_sessions', 'password_resets', 'subscriptions', 'license_permissions',
    'licenses', 'agent_releases', 'app_releases', 'system_settings', 'sessions',
    'permissions', 'users',
];

// Full master setup in ONE migration, so `knex migrate:latest` on a fresh db
// yields a ready-to-login master (schema + permission catalogue + super-admin).
// Idempotent: the schema is applied only when absent, and the seeds no-op if
// present — so a re-run (or a non-empty db) never throws "already exists".
exports.up = async function up(knex) {
    // 1) Schema — apply master-schema.sql only on a fresh db (the plain CREATE
    //    TABLEs would abort with "already exists" on a re-run otherwise).
    const hasUsers = await knex.schema.hasTable('users');
    if (!hasUsers) {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'master-schema.sql'), 'utf8');
        // master-schema.sql is a multi-statement CREATE script; knex.raw runs it via
        // pg's simple-query protocol (no bindings), which allows multiple statements.
        await knex.raw(sql);
    }

    // 2) Auth model tweaks (idempotent). role_id → a TENANT role id (plain int,
    //    no FK) so nullable (super-admin has no tenant); role_slug denormalised
    //    for login/bypass. platform → per-platform sessions. sync_*_modules →
    //    selective auto-sync (NULL = ALL). See Auth/AgentController.
    await knex.raw('ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL').catch(() => {});
    await knex.raw('ALTER TABLE users ADD COLUMN IF NOT EXISTS role_slug varchar(64)').catch(() => {});
    await knex.raw("ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS platform varchar(16)").catch(() => {});
    await knex.raw("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS sync_push_modules text").catch(() => {});
    await knex.raw("ALTER TABLE licenses ADD COLUMN IF NOT EXISTS sync_pull_modules text").catch(() => {});

    // 3) Permission catalogue (23 modules × 5 actions). Idempotent.
    await seedPermissions(knex);

    // 4) Platform super-admin — no license, no tenant → role_id NULL; role_slug
    //    'super-admin' drives the auth bypass. Created once (idempotent).
    const existing = await knex('users').whereRaw('lower(email) = ?', [SUPER_ADMIN_EMAIL.toLowerCase()]).first('id');
    if (!existing) {
        const hash = await passwords.hash(SUPER_ADMIN_PASSWORD);
        await knex('users').insert({
            name: 'Super Admin', email: SUPER_ADMIN_EMAIL, password_hash: hash,
            role_id: null, role_slug: 'super-admin', company_id: null, license_id: null,
            status: 'Active', approval_status: 'approved',
        });
    }
};

exports.down = async function down(knex) {
    for (const t of MASTER_TABLES) {
        await knex.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
};
