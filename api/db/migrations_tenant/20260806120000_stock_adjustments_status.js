'use strict';

/**
 * 20260806120000_stock_adjustments_status.js
 *
 * Physical Stock has no header table of its own (see 20260806040000) — one
 * "sheet" is just the set of `stock_adjustments` rows sharing a `voucher_no`
 * (voucher_kind='physical_stock'). Without a status on those rows there is no
 * way to remember which sheets have already been pushed to Tally: every push
 * cycle would find the same rows pending again and re-send them, filling
 * Tally with duplicate stock corrections that silently falsify the
 * customer's inventory.
 *
 * Adds three nullable/defaulted columns to the EXISTING `stock_adjustments`
 * table, guarded with hasColumn so old rows are untouched:
 *   - `status`           text, default 'draft_cloud' — mirrors stock_journals'
 *                         status column so the two goods vouchers share the
 *                         same push lifecycle (draft_cloud -> pending_tally ->
 *                         created/failed).
 *   - `tally_guid`       string(100), nullable — stamped by result() on sync.
 *   - `tally_voucher_no` string(60), nullable  — stamped by result() on sync.
 *
 * PhysicalStockController.create is updated (separately) to write new sheets
 * with status='pending_tally'; existing rows (all created before this column
 * existed) keep the default 'draft_cloud' and are NEVER pushed, matching
 * every old sheet's actual state — nothing here re-sends history.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn('stock_adjustments', 'status'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.text('status').notNullable().defaultTo('draft_cloud');
        });
    }
    if (!(await knex.schema.hasColumn('stock_adjustments', 'tally_guid'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.string('tally_guid', 100).nullable();
        });
    }
    if (!(await knex.schema.hasColumn('stock_adjustments', 'tally_voucher_no'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.string('tally_voucher_no', 60).nullable();
        });
    }

    // Serves the pending() query: WHERE company_id=? AND voucher_kind='physical_stock' AND status='pending_tally'.
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS stock_adjustments_status_idx
        ON stock_adjustments (company_id, voucher_kind, status)
    `);
};

exports.down = async function down(knex) {
    await knex.raw(`DROP INDEX IF EXISTS stock_adjustments_status_idx`);

    if (await knex.schema.hasColumn('stock_adjustments', 'tally_voucher_no')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('tally_voucher_no');
        });
    }
    if (await knex.schema.hasColumn('stock_adjustments', 'tally_guid')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('tally_guid');
        });
    }
    if (await knex.schema.hasColumn('stock_adjustments', 'status')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('status');
        });
    }
};
