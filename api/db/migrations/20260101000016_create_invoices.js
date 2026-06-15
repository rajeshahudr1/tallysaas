'use strict';

/**
 * 20260101000016_create_invoices.js
 *
 * invoices — sales and purchase vouchers (Tally sales/purchase vouchers).
 *
 * `type` distinguishes 'sales' (uses customer_id) from 'purchase' (uses
 * supplier_id). `invoice_no` is unique PER company PER type. Money columns are
 * numeric(16,2) (round_off is numeric(8,2)) and follow the Indian GST layout:
 * subtotal → discount → taxable → cgst/sgst/igst → tax_amount → round_off →
 * total. `status` walks the Tally sync lifecycle
 * (pending_tally → sent_to_tally → created | failed). `created_by` records the
 * authoring user. Tenant-scoped with soft-delete.
 *
 * Ordered after locations, customers, suppliers, sales_persons and users.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('invoices', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.text('type').notNullable();                           // 'sales' | 'purchase'
        t.string('invoice_no', 60).notNullable();

        t.bigInteger('location_id')
            .nullable()
            .references('id').inTable('locations')
            .onDelete('SET NULL');

        t.bigInteger('customer_id')                             // for sales
            .nullable()
            .references('id').inTable('customers')
            .onDelete('SET NULL');

        t.bigInteger('supplier_id')                            // for purchase
            .nullable()
            .references('id').inTable('suppliers')
            .onDelete('SET NULL');

        t.bigInteger('sales_person_id')
            .nullable()
            .references('id').inTable('sales_persons')
            .onDelete('SET NULL');

        t.string('supplier_bill_no', 60);
        t.date('invoice_date');
        t.date('due_date');

        t.decimal('subtotal',   16, 2).notNullable().defaultTo(0);
        t.decimal('discount',   16, 2).notNullable().defaultTo(0);
        t.decimal('taxable',    16, 2).notNullable().defaultTo(0);
        t.decimal('cgst',       16, 2).notNullable().defaultTo(0);
        t.decimal('sgst',       16, 2).notNullable().defaultTo(0);
        t.decimal('igst',       16, 2).notNullable().defaultTo(0);
        t.decimal('tax_amount', 16, 2).notNullable().defaultTo(0);
        t.decimal('round_off',   8, 2).notNullable().defaultTo(0);
        t.decimal('total',      16, 2).notNullable().defaultTo(0);

        // pending_tally | sent_to_tally | created | failed
        t.text('status').notNullable().defaultTo('pending_tally');
        t.string('tally_voucher_no', 60);
        t.string('tally_guid', 100);
        t.text('pdf_path');
        t.text('notes');

        t.bigInteger('created_by')
            .nullable()
            .references('id').inTable('users')
            .onDelete('SET NULL');

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        // invoice_no unique within a company for a given type
        t.unique(['company_id', 'type', 'invoice_no'], 'uq_invoices_company_type_no');
        t.index(['company_id', 'type', 'status'], 'idx_invoices_company_type_status');
        t.index(['company_id', 'invoice_date'],   'idx_invoices_company_date');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('invoices');
};
