'use strict';

/**
 * Master migration — Data Backup (Task 1, cloud side).
 *
 * The backup itself only happens on the agent's machine (it is the only side
 * that can see the Tally data folder AND the chosen destination). The cloud's
 * job here is limited to two things:
 *   1) STORE THE INTENT — what to back up to, on what schedule, and how many
 *      copies to keep (`license_backup_settings`, one row per license).
 *   2) STORE THE OUTCOME — every run the agent attempted, success or not
 *      (`backup_runs`). A run is never invented cloud-side; the agent is the
 *      only writer of `backup_runs` (see BackupController.recordRun /
 *      AgentController's POST /agent/backup-runs).
 *
 * `run_at` / `frequency` are read ONLY by the agent — the cloud runs no
 * scheduler of its own. `destination_path` is opaque to the cloud (it is a
 * path on the agent's machine); the cloud does not and cannot validate it.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('license_backup_settings'))) {
        await knex.schema.createTable('license_backup_settings', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('license_id').notNullable().unique()
                .references('id').inTable('licenses').onDelete('CASCADE');

            t.boolean('enabled').notNullable().defaultTo(false);
            // Opaque to the cloud — a path on the AGENT's machine. Only checked
            // here for "not empty"; the agent is the one that can see whether it
            // actually exists / is writable.
            t.text('destination_path').nullable();
            // 'daily' | 'weekly'. Read only by the agent's own scheduler.
            t.string('frequency', 20).notNullable().defaultTo('daily');
            // Local time-of-day (agent's machine clock), e.g. '02:00:00'.
            t.time('run_at').notNullable().defaultTo('02:00:00');
            // How many copies the agent keeps at the destination before pruning
            // the oldest. Must be >= 1 (see BackupController — 0 would mean
            // "delete everything", which is refused).
            t.integer('keep_copies').notNullable().defaultTo(7);

            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        });
    }

    if (!(await knex.schema.hasTable('backup_runs'))) {
        await knex.schema.createTable('backup_runs', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('license_id').notNullable()
                .references('id').inTable('licenses').onDelete('CASCADE');

            t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('finished_at', { useTz: true }).nullable();
            // 'running' while the agent is mid-copy; a run that never reports
            // back simply stays 'running' — the cloud never promotes it to
            // 'success' on its own (that would be recording a copy it never saw
            // complete).
            t.string('status', 20).notNullable().defaultTo('running');

            t.integer('files_copied').notNullable().defaultTo(0);
            t.integer('files_skipped').notNullable().defaultTo(0);
            t.bigInteger('bytes_copied').notNullable().defaultTo(0);
            t.text('destination').nullable();
            // Which files were skipped and why (locked, permission denied, …) —
            // the agent's own report, stored verbatim for the run-history screen.
            t.jsonb('skipped_list').nullable();
            t.text('error').nullable();

            t.index(['license_id', 'started_at'], 'backup_runs_license_started_idx');
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('backup_runs');
    await knex.schema.dropTableIfExists('license_backup_settings');
};
