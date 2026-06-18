'use strict';

/**
 * 20260101000043_create_tally_accounting_tables.js
 *
 * Foundation for the EXACT Tally mirror (so Ledger/Trial Balance/Balance Sheet/
 * P&L can be derived to match Tally). The existing customers/suppliers/products/
 * invoices tables stay (UI + the simplified views); these NEW tables hold the
 * FULL accounting data the agent now pulls:
 *
 *   tally_groups            — chart-of-accounts hierarchy (Balance Sheet grouping)
 *   tally_ledgers           — every ledger master + opening/closing balance + GST
 *   tally_voucher_entries   — the DOUBLE ENTRY: every ledger debit/credit of every
 *                             voucher (signed amount). Sum per ledger = its balance.
 *   tally_inventory_entries — item qty/rate/amount per voucher (Stock value/movement)
 *
 * All are company-scoped + carry the Tally GUID / ALTERID so the pull is
 * idempotent + incremental (voucher entries are replaced per-voucher by GUID).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('tally_groups', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.string('name', 255).notNullable();
        t.string('parent', 255);                 // parent group name (hierarchy)
        t.string('primary_group', 100);          // reserved root group
        t.string('nature', 50);                  // Assets / Liabilities / Income / Expenses
        t.boolean('is_revenue').defaultTo(false);
        t.boolean('is_deemed_positive').defaultTo(true);
        t.string('tally_guid', 120);
        t.bigInteger('tally_alter_id').defaultTo(0);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.unique(['company_id', 'name']);
    });

    await knex.schema.createTable('tally_ledgers', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.string('name', 255).notNullable();
        t.string('parent', 255);                 // parent group
        t.decimal('opening_balance', 18, 2).defaultTo(0);   // signed: + Dr, - Cr
        t.decimal('closing_balance', 18, 2).defaultTo(0);
        t.string('gstin', 30);
        t.string('gst_reg_type', 50);
        t.string('state', 100);
        t.text('address');
        t.string('contact', 100);
        t.string('email', 255);
        t.string('bank_name', 255);
        t.string('bank_acc_no', 60);
        t.string('ifsc', 20);
        t.string('tally_guid', 120);
        t.bigInteger('tally_alter_id').defaultTo(0);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.unique(['company_id', 'name']);
    });

    await knex.schema.createTable('tally_voucher_entries', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.string('voucher_guid', 120).notNullable().index();
        t.string('voucher_type', 100);
        t.string('voucher_no', 100);
        t.date('voucher_date');
        t.string('ledger_name', 255).notNullable();
        // SIGNED amount: + debit, - credit (Tally ISDEEMEDPOSITIVE). Sum over a
        // ledger across all entries (+ opening) = its current balance.
        t.decimal('amount', 18, 2).notNullable();
        t.boolean('is_debit');
        t.bigInteger('tally_alter_id').defaultTo(0);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['company_id', 'ledger_name']);
    });

    await knex.schema.createTable('tally_inventory_entries', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.string('voucher_guid', 120).notNullable().index();
        t.date('voucher_date');
        t.string('item_name', 255).notNullable();
        t.decimal('qty', 18, 3).defaultTo(0);    // + inward, - outward
        t.decimal('rate', 18, 4).defaultTo(0);
        t.decimal('amount', 18, 2).defaultTo(0);
        t.string('godown', 255);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['company_id', 'item_name']);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('tally_inventory_entries');
    await knex.schema.dropTableIfExists('tally_voucher_entries');
    await knex.schema.dropTableIfExists('tally_ledgers');
    await knex.schema.dropTableIfExists('tally_groups');
};
