'use strict';

/**
 * Delivery Note voucher — goods-dispatch slip. Same shape as sales_orders
 * (see 20260805180000_sales_orders.js's header comment for the rationale of
 * folding table-create + partial-unique/listing indexes into one migration),
 * with these differences:
 *   - `note_no` / `note_date` in place of `order_no` / `order_date`.
 *   - `dispatch_date` in place of `due_on` — the day goods actually left,
 *     not a future commitment date.
 *   - `sales_order_id` (nullable, indexed) — which order (if any) this note
 *     is dispatching against. No FK: same reasoning as
 *     sales_orders.converted_invoice_id — both sides use soft delete, so an
 *     FK would only risk failures if rows are ever purged independently.
 *   - `delivery_status` (pending / invoiced / cancelled) in place of
 *     order_status — a delivery note's own lifecycle is simpler than an
 *     order's (no partial-delivery concept at the note level).
 *   - `converted_invoice_id` / sync columns unchanged; `tally_voucher_type`
 *     defaults to 'Delivery Note'.
 *
 * Creating a delivery note does NOT touch its linked sales_orders row —
 * partial deliveries are normal, and DeliveryNoteController.create must
 * never mutate order_status.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('delivery_notes'))) {
        await knex.schema.createTable('delivery_notes', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('location_id').nullable();
            t.bigInteger('customer_id').nullable().index();
            t.bigInteger('sales_person_id').nullable();
            t.bigInteger('sales_order_id').nullable().index();
            t.string('note_no', 60).notNullable();
            t.date('note_date').nullable();
            t.date('dispatch_date').nullable();
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
            t.text('delivery_status').notNullable().defaultTo('pending');
            t.bigInteger('converted_invoice_id').nullable();
            t.text('status').notNullable().defaultTo('draft_cloud');
            t.string('tally_voucher_no', 60).nullable();
            t.string('tally_guid', 100).nullable();
            t.string('tally_voucher_type', 64).nullable().defaultTo('Delivery Note');
            t.boolean('tally_optional').notNullable().defaultTo(true);
            t.text('notes').nullable();
            t.bigInteger('created_by').nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('deleted_at', { useTz: true }).nullable();
            t.unique(['company_id', 'note_no'], { indexName: 'delivery_notes_company_no_uq' });
        });
    }
    if (!(await knex.schema.hasTable('delivery_note_items'))) {
        await knex.schema.createTable('delivery_note_items', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('delivery_note_id').notNullable().index();
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
            t.foreign('delivery_note_id').references('id').inTable('delivery_notes').onDelete('CASCADE');
        });
    }

    // 1. Partial unique index on (company_id, note_no) covering only live
    //    rows — soft-deleted notes (deleted_at) must not block number reuse.
    const uqExists = await knex.raw(`
        SELECT 1 FROM pg_constraint WHERE conname = 'delivery_notes_company_no_uq'
    `);
    if (uqExists.rows.length) {
        await knex.raw(`
            ALTER TABLE delivery_notes DROP CONSTRAINT delivery_notes_company_no_uq
        `);
    }
    await knex.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS delivery_notes_company_no_live_uq
        ON delivery_notes (company_id, note_no)
        WHERE deleted_at IS NULL
    `);

    // 2. Listing indexes.
    // Serves: list delivery notes for a company within a date range
    // (WHERE company_id = ? AND note_date BETWEEN ? AND ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS delivery_notes_company_date_idx
        ON delivery_notes (company_id, note_date)
    `);
    // Serves: list delivery notes for a company filtered by delivery_status
    // (WHERE company_id = ? AND delivery_status = ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS delivery_notes_company_status_idx
        ON delivery_notes (company_id, delivery_status)
    `);

    // 3. converted_invoice_id lookup index (no FK — same reasoning as
    // sales_orders: both sides use soft delete, so an FK would only risk
    // conversion failures if invoice rows are ever purged independently).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS delivery_notes_converted_invoice_id_idx
        ON delivery_notes (converted_invoice_id)
    `);
};

exports.down = async function down(knex) {
    const hasDeliveryNotes = await knex.schema.hasTable('delivery_notes');
    if (hasDeliveryNotes) {
        await knex.raw(`DROP INDEX IF EXISTS delivery_notes_converted_invoice_id_idx`);
        await knex.raw(`DROP INDEX IF EXISTS delivery_notes_company_status_idx`);
        await knex.raw(`DROP INDEX IF EXISTS delivery_notes_company_date_idx`);
        await knex.raw(`DROP INDEX IF EXISTS delivery_notes_company_no_live_uq`);
    }

    await knex.schema.dropTableIfExists('delivery_note_items');
    await knex.schema.dropTableIfExists('delivery_notes');
};
