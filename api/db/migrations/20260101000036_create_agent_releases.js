'use strict';

/**
 * 20260101000036_create_agent_releases.js
 *
 * agent_releases — the server-side catalogue of published Tally Cloud Sync
 * Agent executables. A super-admin drops a freshly-built
 * TallyCloudSyncAgent.exe into AGENT_RELEASE_DIR (env, default
 * api/agent-releases/) and PUBLISHES its version here; the single row with
 * is_current=true is the latest the agents auto-update to. The exe FILE lives
 * on disk (streamed by GET /agent/download); this table only holds the
 * metadata + which version is current — so a new release ships WITHOUT a code
 * redeploy.
 *
 *   version     — semantic version string (e.g. "1.0.1"); compared to the
 *                 agent's reported agent_version to decide "newer".
 *   filename    — the basename of the exe inside AGENT_RELEASE_DIR (we only ever
 *                 use basename() of this, so it can never path-traverse).
 *   sha256      — optional hex digest the agent verifies the download against.
 *   notes       — optional release notes (shown on the dashboard / logs).
 *   mandatory   — a security release the agent ALWAYS applies, even if the
 *                 per-license auto_update toggle is OFF.
 *   is_current  — exactly one row is true = the published latest.
 *   size_bytes  — exe size (informational; the download also sets Content-Length).
 *   created_by  — the super-admin user who published it (nullable).
 *
 * Also adds licenses.auto_update (boolean, default true) — the per-license
 * CLOUD toggle Requirement 3 flips. Kept here (one migration) so the agent's
 * /agent/version endpoint can echo it from day one. Additive/defaulted, so
 * existing licenses default to auto-update ON.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('agent_releases', (t) => {
        t.increments('id').primary();
        t.string('version').notNullable();                       // "1.0.1"
        t.string('filename').notNullable();                      // basename of the exe in AGENT_RELEASE_DIR
        t.string('sha256').nullable();                           // hex digest (optional verify)
        t.text('notes').nullable();
        t.boolean('mandatory').notNullable().defaultTo(false);
        t.boolean('is_current').notNullable().defaultTo(false);  // exactly one true = published latest
        t.bigInteger('size_bytes').nullable();
        t.integer('created_by').nullable();                      // super-admin user id (no FK; users may be license-scoped)
        t.timestamp('created_at').defaultTo(knex.fn.now());

        // The agent's hot path reads the single current release.
        t.index(['is_current']);
    });

    // Per-license CLOUD auto-update toggle (Requirement 3). Default ON.
    await knex.schema.alterTable('licenses', (t) => {
        t.boolean('auto_update').notNullable().defaultTo(true);
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('auto_update');
    });
    await knex.schema.dropTableIfExists('agent_releases');
};
