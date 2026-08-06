'use strict';

/**
 * Tenant migration 005 — the remaining fields CALCULATIONS depend on.
 *
 * Everything here is a number (or the link needed to attribute a number), which
 * is why it matters more than its size suggests: each one silently changes a
 * total rather than just being absent.
 *
 *  • DISCOUNT on an inventory line — Tally's AMOUNT is already net of it, but
 *    without the discount the cloud cannot reproduce gross → discount → net, so
 *    a re-derived invoice total disagrees with Tally's.
 *  • ACTUAL vs BILLED qty — these differ on shortages/free issues. Stock
 *    valuation must use ACTUAL, invoice value must use BILLED. Storing one
 *    number for both makes one of the two wrong.
 *  • INVENTORY→ACCOUNTING allocations — which sales/purchase LEDGER each item
 *    line posts to. The importer folded these into the flat ledger entries, so
 *    the item↔ledger link was lost and per-item / per-ledger P&L could not be
 *    computed at all.
 *  • is_party_ledger / ledger_from_item on a ledger entry — tells the party leg
 *    apart from tax and round-off legs without name-matching heuristics (the
 *    current code guesses "round" by regex on the ledger NAME).
 *  • Price lists, BOM components and batch masters — tables exist since
 *    migration 004 but nothing populated them; rate lookups and manufacturing
 *    cost roll-ups need them.
 */

exports.up = async function up(knex) {
    // ── Ledger entries: identify the leg without guessing from its name ──
    if (await knex.schema.hasTable('tally_voucher_entries')) {
        const add = async (col, build) => {
            if (!(await knex.schema.hasColumn('tally_voucher_entries', col))) {
                await knex.schema.alterTable('tally_voucher_entries', build);
            }
        };
        await add('is_party_ledger', (t) => t.boolean('is_party_ledger').defaultTo(false));
        // True when this posting was generated FROM an inventory line (the
        // sales/purchase leg) rather than entered directly.
        await add('ledger_from_item', (t) => t.boolean('ledger_from_item').defaultTo(false));
        await add('amount_rate', (t) => t.string('amount_rate', 60).nullable());
    }

    // ── Inventory entries: the numbers a valuation actually needs ──
    if (await knex.schema.hasTable('tally_inventory_entries')) {
        const add = async (col, build) => {
            if (!(await knex.schema.hasColumn('tally_inventory_entries', col))) {
                await knex.schema.alterTable('tally_inventory_entries', build);
            }
        };
        // `qty` stays as-is (billed) so existing reads keep working; these are
        // the explicit pair.
        await add('actual_qty', (t) => t.decimal('actual_qty', 18, 3).defaultTo(0));
        await add('billed_qty', (t) => t.decimal('billed_qty', 18, 3).defaultTo(0));
        await add('discount', (t) => t.decimal('discount', 8, 3).defaultTo(0));
        await add('unit', (t) => t.string('unit', 60).nullable());
        await add('tracking_no', (t) => t.string('tracking_no', 120).nullable());
        await add('order_no', (t) => t.string('order_no', 120).nullable());
        await add('order_due_date', (t) => t.date('order_due_date').nullable());
        await add('is_deemed_positive', (t) => t.boolean('is_deemed_positive').defaultTo(false));
        // Backfill the pair from the single qty we have been storing all along,
        // so a report switching to billed_qty does not read zeros for history.
        await knex.raw(`UPDATE tally_inventory_entries
                        SET billed_qty = qty, actual_qty = qty
                        WHERE billed_qty = 0 AND actual_qty = 0 AND qty <> 0`);
    }

    // ── Item line → accounting ledger. The link that makes per-item and
    //    per-ledger P&L possible. ──
    if (!(await knex.schema.hasTable('tally_inventory_accounting_allocations'))) {
        await knex.schema.createTable('tally_inventory_accounting_allocations', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('voucher_guid', 120).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            t.string('item_name', 255).nullable();
            t.string('ledger_name', 255).notNullable();
            t.decimal('amount', 18, 2).defaultTo(0);
            t.boolean('is_debit').defaultTo(false);
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'voucher_guid', 'line_no'], { indexName: 'tally_inv_acc_line_uq' });
            t.index(['company_id', 'ledger_name'], 'tally_inv_acc_ledger_idx');
            t.index(['company_id', 'item_name'], 'tally_inv_acc_item_idx');
            t.foreign(['company_id', 'voucher_guid'], 'tally_inv_acc_voucher_fk')
                .references(['company_id', 'guid']).inTable('tally_vouchers').onDelete('CASCADE');
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('tally_inventory_accounting_allocations');
    await knex.schema.alterTable('tally_voucher_entries', (t) => {
        t.dropColumn('is_party_ledger'); t.dropColumn('ledger_from_item'); t.dropColumn('amount_rate');
    }).catch(() => {});
    await knex.schema.alterTable('tally_inventory_entries', (t) => {
        t.dropColumn('actual_qty'); t.dropColumn('billed_qty'); t.dropColumn('discount');
        t.dropColumn('unit'); t.dropColumn('tracking_no'); t.dropColumn('order_no');
        t.dropColumn('order_due_date'); t.dropColumn('is_deemed_positive');
    }).catch(() => {});
};
