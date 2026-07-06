'use strict';

/**
 * 20260101000056_create_tally_reports.js
 *
 * Stores Tally's OWN financial reports (Balance Sheet / Profit & Loss / Trial
 * Balance) pulled VERBATIM by the agent, so the cloud mirrors every figure
 * EXACTLY instead of reconstructing from ledgers (which drifts on inventory /
 * opening-balance differences). One row per (company, report_type); the agent
 * upserts it each sync. `payload` is the parsed report JSON.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('tally_reports', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.string('report_type', 40).notNullable();   // balance_sheet | profit_loss | trial_balance
        t.jsonb('payload').notNullable();
        t.timestamp('synced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.unique(['company_id', 'report_type'], 'uq_tally_reports_company_type');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('tally_reports');
};
