'use strict';

/**
 * 20260806140000_stock_adjustments_godown.js
 *
 * Physical Stock (see PhysicalStockController) writes its lines into
 * `stock_adjustments`, the same audit table InventoryController.adjust uses.
 * That table has no `godown` column, so PhysicalStockController.create was
 * writing each line's godown into `notes`. Commit 6f78431 then started
 * writing the sheet's narration into that same `notes` column
 * (`notes: narration || it.godown || null`) — so a sheet with a narration
 * silently drops every line's godown, and a sheet without one has `notes`
 * holding a godown instead of a note. Two meanings, one column.
 *
 * `stock_journal_items` already has a dedicated `godown` column (see
 * 20260806040000_stock_vouchers.js) — this gives `stock_adjustments` the
 * same column so PhysicalStockController can stop overloading `notes`.
 *
 * Nullable, guarded with hasColumn so old rows are untouched. Existing rows'
 * `notes` currently hold a godown value, not a real note — this migration
 * does NOT attempt to move that value into the new column (see the
 * PhysicalStockController change for why), so old rows simply have
 * `godown IS NULL` until re-counted.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn('stock_adjustments', 'godown'))) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.string('godown', 120).nullable();
        });
    }
};

exports.down = async function down(knex) {
    if (await knex.schema.hasColumn('stock_adjustments', 'godown')) {
        await knex.schema.alterTable('stock_adjustments', (t) => {
            t.dropColumn('godown');
        });
    }
};
