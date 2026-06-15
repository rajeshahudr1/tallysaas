'use strict';

/**
 * 20260101000017_create_invoice_items.js
 *
 * invoice_items — line items belonging to an invoice.
 *
 * `invoice_id` is FK with onDelete CASCADE — deleting (hard-deleting) an
 * invoice removes its lines. `product_id` is nullable so ad-hoc / free-text
 * lines are allowed. Per-line math: quantity × rate → taxable (after
 * discount_pct) → gst_amount (at gst_rate) → amount. Money columns are
 * numeric(16,2); quantity/rate are numeric(14,2); percentages numeric(5,2).
 *
 * Carries company_id for tenant-scoped reporting. Spec keeps only created_at
 * (lines are immutable once written). Ordered after invoices and products.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('invoice_items', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('invoice_id')
            .notNullable()
            .references('id').inTable('invoices')
            .onDelete('CASCADE');                               // lines die with the invoice

        t.bigInteger('product_id')
            .nullable()
            .references('id').inTable('products')
            .onDelete('SET NULL');

        t.text('description');
        t.string('hsn', 20);
        t.decimal('quantity', 14, 2).notNullable().defaultTo(0);
        t.string('unit', 30);
        t.decimal('rate',         14, 2).notNullable().defaultTo(0);
        t.decimal('discount_pct',  5, 2).notNullable().defaultTo(0);
        t.decimal('taxable',      16, 2).notNullable().defaultTo(0);
        t.decimal('gst_rate',      5, 2).notNullable().defaultTo(0);
        t.decimal('gst_amount',   16, 2).notNullable().defaultTo(0);
        t.decimal('amount',       16, 2).notNullable().defaultTo(0);

        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

        t.index('invoice_id', 'idx_invoice_items_invoice_id');
        t.index('company_id', 'idx_invoice_items_company_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('invoice_items');
};
