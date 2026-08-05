'use strict';

/**
 * api/db/migrations_tenant/20260806020000_invoice_against_ref.js
 *
 * Adds `invoices.against_invoice_id` — which original bill a Credit/Debit
 * Note (ReturnNoteController) is issued against. Nullable: a note can stand
 * alone. No FK (same reasoning used throughout this project for soft-deleted
 * cross-references, e.g. delivery_notes.sales_order_id) — both sides use
 * soft delete, so an FK would only risk write failures if rows are ever
 * purged independently. Indexed for the "against this bill" lookup.
 *
 * Credit/Debit Notes are NOT a new table — they are rows in the existing
 * `invoices` table (type='sales'+tally_voucher_type='Credit Note' or
 * type='purchase'+tally_voucher_type='Debit Note'), same table Tally-synced
 * notes already land in. This migration only adds the one new column.
 */

exports.up = async function up(knex) {
    const hasCol = await knex.schema.hasColumn('invoices', 'against_invoice_id');
    if (!hasCol) {
        await knex.schema.alterTable('invoices', (t) => {
            t.bigInteger('against_invoice_id').nullable();
        });
    }
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS invoices_against_invoice_id_idx
        ON invoices (against_invoice_id)
    `);
};

exports.down = async function down(knex) {
    await knex.raw(`DROP INDEX IF EXISTS invoices_against_invoice_id_idx`);
    const hasCol = await knex.schema.hasColumn('invoices', 'against_invoice_id');
    if (hasCol) {
        await knex.schema.alterTable('invoices', (t) => {
            t.dropColumn('against_invoice_id');
        });
    }
};
