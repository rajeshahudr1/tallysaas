'use strict';

/**
 * 20260101000041_add_sync_enabled_to_licenses.js
 *
 * Per-LICENSE master AUTO-SYNC switch (the "Auto-sync" on/off).
 *
 *   sync_enabled — when true (the default), the agent's automatic loop runs as
 *                  gated by the per-direction toggles (sync_push_enabled /
 *                  sync_pull_enabled). When false, NOTHING auto-syncs: the
 *                  heartbeat returns EFFECTIVE push/pull = false regardless of
 *                  the direction toggles, so the already-deployed agent (no
 *                  rebuild) skips ALL automatic push AND pull until it is turned
 *                  back ON. Manual per-module "Sync to Tally" / "Sync from
 *                  Tally" actions are NOT gated by this flag.
 *
 * This is the master switch that sits above the two direction toggles added in
 * 20260101000037 (push/pull): Auto-sync OFF beats both; with Auto-sync ON the
 * direction toggles decide which passes run.
 *
 * boolean, NOT NULL, default true — so EVERY existing license keeps today's
 * behaviour (auto-sync ON) with no regression, and a heartbeat from an older
 * server (no column) is treated as ON by the agent. Additive/defaulted, so
 * existing data is untouched.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.boolean('sync_enabled').notNullable().defaultTo(true);
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('sync_enabled');
    });
};
