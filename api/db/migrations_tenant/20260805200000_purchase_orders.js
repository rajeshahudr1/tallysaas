'use strict';

/**
 * Purchase Order voucher — sales_orders जैसा शेप, पर पार्टी **supplier** है
 * (`supplier_id`, कोई `sales_person_id` नहीं — ख़रीद salesman से नहीं जुड़ी)।
 * `due_on` (माल कब आना है) और `order_status` (pending / partially_delivered /
 * delivered / cancelled) डिलीवरी-प्रगति ट्रैक करते हैं, `status` अलग से Tally
 * sync की हालत रखता है। हर row `draft_cloud` पर बनती है; Part 2 (Tally push)
 * उसे `pending_tally` करेगा।
 *
 * sales_orders (20260805180000_sales_orders.js) की तरह table create +
 * partial-unique/listing indexes एक ही migration में।
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('purchase_orders'))) {
        await knex.schema.createTable('purchase_orders', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('location_id').nullable();
            t.bigInteger('supplier_id').nullable().index();
            t.string('order_no', 60).notNullable();
            t.date('order_date').nullable();
            t.date('due_on').nullable();
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
            t.text('order_status').notNullable().defaultTo('pending');
            t.bigInteger('converted_invoice_id').nullable();
            t.text('status').notNullable().defaultTo('draft_cloud');
            t.string('tally_voucher_no', 60).nullable();
            t.string('tally_guid', 100).nullable();
            t.string('tally_voucher_type', 64).nullable().defaultTo('Purchase Order');
            t.boolean('tally_optional').notNullable().defaultTo(true);
            t.text('notes').nullable();
            t.bigInteger('created_by').nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('deleted_at', { useTz: true }).nullable();
            t.unique(['company_id', 'order_no'], { indexName: 'purchase_orders_company_no_uq' });
        });
    }
    if (!(await knex.schema.hasTable('purchase_order_items'))) {
        await knex.schema.createTable('purchase_order_items', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('purchase_order_id').notNullable().index();
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
            t.foreign('purchase_order_id').references('id').inTable('purchase_orders').onDelete('CASCADE');
        });
    }

    // 1. Partial unique index on (company_id, order_no) covering only live
    //    rows — soft-deleted orders (deleted_at) must not block number reuse.
    const uqExists = await knex.raw(`
        SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_company_no_uq'
    `);
    if (uqExists.rows.length) {
        await knex.raw(`
            ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_company_no_uq
        `);
    }
    await knex.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_company_no_live_uq
        ON purchase_orders (company_id, order_no)
        WHERE deleted_at IS NULL
    `);

    // 2. Listing indexes.
    // Serves: list purchase orders for a company within a date range
    // (WHERE company_id = ? AND order_date BETWEEN ? AND ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS purchase_orders_company_date_idx
        ON purchase_orders (company_id, order_date)
    `);
    // Serves: list purchase orders for a company filtered by order_status
    // (WHERE company_id = ? AND order_status = ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS purchase_orders_company_status_idx
        ON purchase_orders (company_id, order_status)
    `);

    // 3. converted_invoice_id lookup index (no FK — same reasoning as
    // sales_orders: both sides use soft delete, so an FK would only risk
    // conversion failures if invoice rows are ever purged independently).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS purchase_orders_converted_invoice_id_idx
        ON purchase_orders (converted_invoice_id)
    `);
};

exports.down = async function down(knex) {
    const hasPurchaseOrders = await knex.schema.hasTable('purchase_orders');
    if (hasPurchaseOrders) {
        await knex.raw(`DROP INDEX IF EXISTS purchase_orders_converted_invoice_id_idx`);
        await knex.raw(`DROP INDEX IF EXISTS purchase_orders_company_status_idx`);
        await knex.raw(`DROP INDEX IF EXISTS purchase_orders_company_date_idx`);
        await knex.raw(`DROP INDEX IF EXISTS purchase_orders_company_no_live_uq`);
    }

    await knex.schema.dropTableIfExists('purchase_order_items');
    await knex.schema.dropTableIfExists('purchase_orders');
};
