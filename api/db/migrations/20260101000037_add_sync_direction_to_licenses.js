'use strict';

/**
 * 20260101000037_add_sync_direction_to_licenses.js
 *
 * Per-LICENSE auto-sync DIRECTION toggles (Requirement 1).
 *
 *   sync_push_enabled — when true, the agent's AUTO loop runs the PUSH pass
 *                       (cloud -> Tally) each cycle. When false, the agent
 *                       SKIPS _sync_pass (it still heartbeats + drains commands).
 *   sync_pull_enabled — when true, the agent's AUTO loop runs the PULL pass
 *                       (Tally -> cloud) each cycle. When false, the agent
 *                       SKIPS _pull_pass.
 *
 * These gate ONLY the agent's automatic sync loop. The web Sync Dashboard's
 * MANUAL per-module "Sync to Tally" / "Sync from Tally" buttons are NOT gated
 * by these flags — a manual action is always honoured.
 *
 * Both columns are boolean, NOT NULL, default true — so EVERY existing license
 * keeps today's behaviour (both directions ON) with no regression, and a heart-
 * beat from an older server (no columns) is treated as both-ON by the agent.
 * Additive/defaulted, so existing data is untouched.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.boolean('sync_push_enabled').notNullable().defaultTo(true);
        t.boolean('sync_pull_enabled').notNullable().defaultTo(true);
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('sync_push_enabled');
        t.dropColumn('sync_pull_enabled');
    });
};
