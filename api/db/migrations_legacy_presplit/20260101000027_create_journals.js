'use strict';

/**
 * 20260101000027_create_journals.js
 *
 * Journal vouchers — a simple two-ledger accounting entry (Debit one ledger,
 * Credit another) that syncs to Tally as a Journal voucher. Works without
 * inventory, so it pushes even from an accounts-only Tally company.
 *
 * Kept minimal: dr_ledger / cr_ledger are ledger NAMES (free text, usually a
 * customer/supplier or an account like Cash / Bank / Discount). status follows
 * the same flow as invoices/payments (pending_tally → created | failed).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('journals', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.string('voucher_no', 40).nullable();
        t.date('journal_date').notNullable();
        t.string('dr_ledger', 191).notNullable();
        t.string('cr_ledger', 191).notNullable();
        t.decimal('amount', 16, 2).notNullable().defaultTo(0);
        t.text('narration').nullable();
        t.text('status').notNullable().defaultTo('pending_tally');
        t.string('tally_voucher_no', 60).nullable();
        t.string('tally_guid', 120).nullable();
        t.bigInteger('created_by').nullable();
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('journals');
};
