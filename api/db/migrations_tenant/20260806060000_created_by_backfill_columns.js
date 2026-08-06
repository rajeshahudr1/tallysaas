'use strict';

/**
 * api/db/migrations_tenant/20260806060000_created_by_backfill_columns.js
 *
 * `created_by` bigint nullable + index on the three tables that never got it:
 * `customers`, `products`, `receipts`. (Every other voucher table already
 * carries `created_by` — see InvoiceController.createByType / the base
 * tenant-schema.sql — this migration only fills the gap.)
 *
 * `receipts` is not a real standalone table today (money-in vouchers live in
 * the shared `payments` table, discriminated by `type = 'receipt'`, which
 * already has `created_by`) — the `hasTable` guard below simply no-ops for
 * it, same as customer_party_fields.js's style for an absent table.
 *
 * NO BACKFILL: who created an EXISTING row was never recorded, so guessing
 * an author for old data would invent history that isn't true. Empty means
 * "unknown" — the UI says so. `down` only drops the columns it added.
 */

const TABLES = ['customers', 'products', 'receipts'];

exports.up = async function up(knex) {
    for (const t of TABLES) {
        if (!(await knex.schema.hasTable(t))) continue;
        if (await knex.schema.hasColumn(t, 'created_by')) continue;
        await knex.schema.alterTable(t, (table) => {
            table.bigInteger('created_by').nullable().index();
        });
    }
};

exports.down = async function down(knex) {
    for (const t of TABLES) {
        if (!(await knex.schema.hasTable(t))) continue;
        if (!(await knex.schema.hasColumn(t, 'created_by'))) continue;
        await knex.schema.alterTable(t, (table) => {
            table.dropColumn('created_by');
        });
    }
};
