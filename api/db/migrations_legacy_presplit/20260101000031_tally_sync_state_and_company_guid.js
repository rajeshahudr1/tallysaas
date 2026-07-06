'use strict';

/**
 * 20260101000031_tally_sync_state_and_company_guid.js
 *
 * INCREMENTAL Tally <-> cloud sync support.
 *
 * 1) tally_sync_state — one row per company holding the cloud's per-company
 *    high-water mark of the largest Tally ALTERID it has processed. The PULL
 *    (Tally -> cloud) sends ALL masters (each carrying its Tally alterid); the
 *    cloud processes only those with alterid > master_alter_id, upserts them,
 *    and advances the watermark. This makes the pull skip unchanged masters and
 *    stop re-reading/re-writing the same data every cycle. `voucher_alter_id`
 *    is reserved for a future voucher watermark (vouchers currently dedup by
 *    tally_voucher_no, so it is unused for now).
 *
 * 2) companies.tally_guid — marks a CLOUD company as already created in Tally.
 *    A web-made company has tally_guid NULL until the agent creates it in Tally
 *    and reports back (result() stamps tally_guid='tally'). /agent/pending
 *    returns NULL ones so the agent knows which companies to create in Tally.
 *
 * Both are additive/nullable so existing data + the working PUSH path are
 * untouched.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('tally_sync_state', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        // Per-company high-water mark of the largest Tally ALTERID processed.
        t.bigInteger('master_alter_id').notNullable().defaultTo(0);
        t.bigInteger('voucher_alter_id').notNullable().defaultTo(0);

        t.timestamp('last_pull_at', { useTz: true }).nullable();
        t.timestamp('last_push_at', { useTz: true }).nullable();

        t.timestamps(true, true);

        // One watermark row per company.
        t.unique(['company_id'], 'uq_tally_sync_state_company');
    });

    await knex.schema.alterTable('companies', (t) => {
        // NULL until this cloud company has been created in Tally by the agent.
        t.string('tally_guid', 100).nullable();
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('companies', (t) => {
        t.dropColumn('tally_guid');
    });
    await knex.schema.dropTableIfExists('tally_sync_state');
};
