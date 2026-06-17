'use strict';

/**
 * 20260101000035_create_record_history.js
 *
 * record_history — per-record CHANGE HISTORY across every module.
 *
 * Captures "what it was BEFORE and what it is NOW" for every CRUD write on the
 * web/app side AND for every change the Tally→cloud sync makes. One row per
 * change event for a record:
 *
 *   module        customers | suppliers | products | categories | locations |
 *                 sales-persons | sales-invoices | purchase-invoices |
 *                 payments | receipts | journals ...
 *   record_type   a finer label (usually == module, but e.g. 'customer')
 *   record_id     the live row id (NULLABLE — a delete may keep it; some
 *                 voucher pulls have no single id, so loose BigInt, NO hard FK)
 *   action        created | updated | deleted | synced | reverted
 *   source        cloud | tally | agent | system
 *   before_json   JSON.stringify(before)  (NULL on a create)
 *   after_json    JSON.stringify(after)   (NULL on a delete)
 *   changed_fields JSON array of the field names that actually changed
 *   changed_by    users.id of the actor (NULL for agent/system writes)
 *   note          optional free-text note (e.g. the revert source entry id)
 *
 * Tenant-scoped by company_id (hard FK, CASCADE). Append-only — no soft delete.
 * before/after are stored as TEXT (JSON) so the shape is never schema-bound.
 *
 * Indexes:
 *   (company_id, module, record_id) — the per-record timeline / compare view.
 *   (company_id, created_at)        — the company-wide "recent changes" feed.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('record_history', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('module', 60).notNullable();                   // customers | products ...
        t.string('record_type', 60);
        t.bigInteger('record_id').nullable();                   // loose ref (no FK)

        t.string('action', 20).notNullable();                   // created|updated|deleted|synced|reverted
        t.string('source', 20).notNullable().defaultTo('cloud'); // cloud|tally|agent|system

        t.text('before_json').nullable();
        t.text('after_json').nullable();
        t.text('changed_fields').nullable();                    // JSON array of field names

        t.integer('changed_by').nullable();                     // users.id (no hard FK — agent/system rows have none)
        t.string('note', 255).nullable();

        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        t.index(['company_id', 'module', 'record_id'], 'idx_record_history_company_module_record');
        t.index(['company_id', 'created_at'], 'idx_record_history_company_created');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('record_history');
};
