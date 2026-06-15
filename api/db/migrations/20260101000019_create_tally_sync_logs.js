'use strict';

/**
 * 20260101000019_create_tally_sync_logs.js
 *
 * tally_sync_logs — audit trail of every Tally push/pull attempt.
 *
 * One row per sync attempt for a record. `module` + `record_type` + `record_id`
 * identify the source object (record_id is a loose BigInt, nullable, NOT a hard
 * FK because it may point at any of several tables). `direction` is push|pull,
 * `status` is pending|synced|failed. The raw `request_xml`/`response_xml`
 * envelopes are stored for debugging; `retry_count` and `synced_at` track
 * retries. Tenant-scoped; no soft-delete (logs are append-only history).
 *
 * Ordered last among data tables that need company_id; references only companies.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('tally_sync_logs', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('module', 60);                                 // customers | invoices ...
        t.string('record_type', 60);
        t.bigInteger('record_id').nullable();                   // loose ref (no FK)

        t.text('direction').notNullable().defaultTo('push');    // push | pull
        t.text('status').notNullable().defaultTo('pending');    // pending | synced | failed

        t.text('request_xml');
        t.text('response_xml');
        t.text('message');
        t.integer('retry_count').notNullable().defaultTo(0);
        t.timestamp('synced_at', { useTz: true });

        t.timestamps(true, true);

        t.index(['company_id', 'status'], 'idx_tally_sync_logs_company_status');
        t.index(['company_id', 'module'], 'idx_tally_sync_logs_company_module');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('tally_sync_logs');
};
