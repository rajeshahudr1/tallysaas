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

// The 11 master tables, dependents first (CASCADE covers the rest) — for down().
const MASTER_TABLES = [
    'user_sessions', 'password_resets', 'subscriptions', 'license_permissions',
    'licenses', 'agent_releases', 'app_releases', 'system_settings', 'sessions',
    'permissions', 'users',
];

exports.up = async function up(knex) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'master-schema.sql'), 'utf8');
    // master-schema.sql is a multi-statement CREATE script; knex.raw runs it via
    // pg's simple-query protocol (no bindings), which allows multiple statements.
    await knex.raw(sql);

    // Auth model: role_id → a TENANT role id (plain int, no FK), so nullable
    // (super-admin has no tenant); role_slug denormalised for login/bypass.
    await knex.raw('ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL').catch(() => {});
    await knex.raw('ALTER TABLE users ADD COLUMN IF NOT EXISTS role_slug varchar(64)').catch(() => {});
    // Per-platform sessions: user_sessions.platform ('web'|'app') so a web login
    // and an app login coexist (one live session per platform). See AuthController.
    await knex.raw("ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS platform varchar(16)").catch(() => {});
};

exports.down = async function down(knex) {
    for (const t of MASTER_TABLES) {
        await knex.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
};
