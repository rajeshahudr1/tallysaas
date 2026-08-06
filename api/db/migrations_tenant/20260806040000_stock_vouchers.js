'use strict';

/**
 * 20260806040000_stock_vouchers.js
 *
 * Stock Journal and Physical Stock are GOODS vouchers — no ledger, no GST, no
 * money totals. They move stock the same way InventoryController.adjust
 * already does: mutate `products.opening_stock` and write an audit row into
 * `stock_adjustments`, both inside one transaction. This migration adds:
 *
 *   1. `stock_journals` — the header (voucher_no, journal_date, narration,
 *      Tally sync columns). `voucher_no` gets a partial unique index (live
 *      rows only, same pattern as delivery_notes_company_no_live_uq) and
 *      (company_id, journal_date) gets a listing index.
 *   2. `stock_journal_items` — one row per source/destination line
 *      (`direction`), FK CASCADE to stock_journals.
 *   3. Two new nullable columns on the EXISTING `stock_adjustments` table —
 *      `voucher_no` and `voucher_kind` — so a Physical Stock sheet's rows
 *      (voucher_kind='physical_stock') or a Stock Journal's derived
 *      adjustments (voucher_kind='stock_journal') can be grouped back into
 *      one slip by voucher_no. Old rows keep these columns NULL and the
 *      existing /inventory/adjust path is untouched.
 *
 * Physical Stock has NO header table of its own — a "sheet" is just the set
 * of stock_adjustments rows sharing one voucher_no (voucher_kind =
 * 'physical_stock'), grouped by PhysicalStockController.list.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('stock_journals'))) {
        await knex.schema.createTable('stock_journals', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.string('voucher_no', 60).notNullable();
            t.date('journal_date').nullable();
            t.text('narration').nullable();
            t.text('status').notNullable().defaultTo('draft_cloud');
            t.string('tally_voucher_no', 60).nullable();
            t.string('tally_guid', 100).nullable();
            t.string('tally_voucher_type', 64).nullable().defaultTo('Stock Journal');
            t.bigInteger('created_by').nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('deleted_at', { useTz: true }).nullable();
        });
    }

    if (!(await knex.schema.hasTable('stock_journal_items'))) {
        await knex.schema.createTable('stock_journal_items', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('stock_journal_id').notNullable().index();
            t.bigInteger('product_id').nullable();
            t.string('direction', 20).notNullable();      // 'source' | 'destination'
            t.string('godown', 120).nullable();
            t.decimal('quantity', 14, 2).notNullable().defaultTo(0);
            t.decimal('rate', 16, 2).nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.foreign('stock_journal_id').references('id').inTable('stock_journals').onDelete('CASCADE');
        });
    }

    // Partial unique index on (company_id, voucher_no) covering only live
    // rows — soft-deleted journals must not block number reuse.
    await knex.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS stock_journals_company_no_live_uq
        ON stock_journals (company_id, voucher_no)
        WHERE deleted_at IS NULL
    `);

    // Listing index — WHERE company_id = ? AND journal_date BETWEEN ? AND ?.
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS stock_journals_company_date_idx
        ON stock_journals (company_id, journal_date)
    `);

    // Two new nullable tag columns on the EXISTING stock_adjustments table so
    // a voucher's rows can be grouped back together. Guarded with hasColumn —
    // old rows stay NULL and /inventory/adjust is unaffected.
    if (!(await knex.schema.hasColumn('stock_adjustments', 'voucher_no'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.string('voucher_no', 60).nullable();
        });
    }
    if (!(await knex.schema.hasColumn('stock_adjustments', 'voucher_kind'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.string('voucher_kind', 30).nullable();
        });
    }

    // Serves PhysicalStockController.list's group-by-voucher_no query.
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS stock_adjustments_voucher_idx
        ON stock_adjustments (company_id, voucher_kind, voucher_no)
    `);
};

exports.down = async function down(knex) {
    await knex.raw(`DROP INDEX IF EXISTS stock_adjustments_voucher_idx`);

    if (await knex.schema.hasColumn('stock_adjustments', 'voucher_kind')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('voucher_kind');
        });
    }
    if (await knex.schema.hasColumn('stock_adjustments', 'voucher_no')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('voucher_no');
        });
    }

    const hasJournals = await knex.schema.hasTable('stock_journals');
    if (hasJournals) {
        await knex.raw(`DROP INDEX IF EXISTS stock_journals_company_date_idx`);
        await knex.raw(`DROP INDEX IF EXISTS stock_journals_company_no_live_uq`);
    }

    await knex.schema.dropTableIfExists('stock_journal_items');
    await knex.schema.dropTableIfExists('stock_journals');
};
