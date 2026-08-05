'use strict';

/**
 * Quotation voucher — भाव-पत्र। ledger/stock/GST पर कोई असर नहीं, इसलिए यह
 * invoices से अलग tables में रहता है। `quote_status` सौदे की हालत है
 * (open/accepted/rejected), `status` Tally sync की — दोनों अलग चीज़ें।
 * Part 1 में हर row `draft_cloud` पर बनती है; Part 2 (Tally push) उसे
 * `pending_tally` करेगा।
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('quotations'))) {
        await knex.schema.createTable('quotations', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('location_id').nullable();
            t.bigInteger('customer_id').nullable().index();
            t.bigInteger('sales_person_id').nullable();
            t.string('quotation_no', 60).notNullable();
            t.date('quotation_date').nullable();
            t.date('valid_till').nullable();
            t.string('ledger_name', 120).nullable();
            t.decimal('subtotal', 16, 2).notNullable().defaultTo(0);
            t.decimal('discount', 16, 2).notNullable().defaultTo(0);
            t.decimal('taxable', 16, 2).notNullable().defaultTo(0);
            t.decimal('cgst', 16, 2).notNullable().defaultTo(0);
            t.decimal('sgst', 16, 2).notNullable().defaultTo(0);
            t.decimal('igst', 16, 2).notNullable().defaultTo(0);
            t.decimal('tax_amount', 16, 2).notNullable().defaultTo(0);
            t.decimal('round_off', 8, 2).notNullable().defaultTo(0);
            t.decimal('total', 16, 2).notNullable().defaultTo(0);
            t.text('quote_status').notNullable().defaultTo('open');
            t.bigInteger('converted_invoice_id').nullable();
            t.text('status').notNullable().defaultTo('draft_cloud');
            t.string('tally_voucher_no', 60).nullable();
            t.string('tally_guid', 100).nullable();
            t.string('tally_voucher_type', 64).nullable().defaultTo('Quotation');
            t.boolean('tally_optional').notNullable().defaultTo(true);
            t.text('notes').nullable();
            t.bigInteger('created_by').nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('deleted_at', { useTz: true }).nullable();
            t.unique(['company_id', 'quotation_no'], { indexName: 'quotations_company_no_uq' });
        });
    }
    if (!(await knex.schema.hasTable('quotation_items'))) {
        await knex.schema.createTable('quotation_items', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('quotation_id').notNullable().index();
            t.bigInteger('product_id').nullable();
            t.text('description').nullable();
            t.string('hsn', 20).nullable();
            t.decimal('quantity', 16, 3).notNullable().defaultTo(0);
            t.string('unit', 20).nullable();
            t.decimal('rate', 16, 2).notNullable().defaultTo(0);
            t.decimal('discount_pct', 5, 2).notNullable().defaultTo(0);
            t.decimal('taxable', 16, 2).notNullable().defaultTo(0);
            t.decimal('gst_rate', 5, 2).notNullable().defaultTo(0);
            t.decimal('gst_amount', 16, 2).notNullable().defaultTo(0);
            t.decimal('amount', 16, 2).notNullable().defaultTo(0);
            t.string('godown', 120).nullable();
            t.boolean('tax_inclusive').notNullable().defaultTo(false);
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.foreign('quotation_id').references('id').inTable('quotations').onDelete('CASCADE');
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('quotation_items');
    await knex.schema.dropTableIfExists('quotations');
};
