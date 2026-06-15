'use strict';

/**
 * 20260101000026_create_stock_adjustments.js
 *
 * Audit ledger for manual stock adjustments (damage, physical-count
 * correction, opening entry, etc.). Each row records the before/after stock
 * so the change is traceable; the product's `opening_stock` (what the
 * Inventory page reads as "current") is updated in the same transaction.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('stock_adjustments', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();
        t.bigInteger('product_id').notNullable()
            .references('id').inTable('products').onDelete('CASCADE');
        t.bigInteger('location_id').nullable();
        t.string('type', 10).notNullable();              // add | remove | set
        t.decimal('quantity', 14, 2).notNullable().defaultTo(0);
        t.decimal('before_qty', 14, 2).notNullable().defaultTo(0);
        t.decimal('after_qty', 14, 2).notNullable().defaultTo(0);
        t.string('reason', 120).nullable();
        t.text('notes').nullable();
        t.date('adjustment_date').nullable();
        t.bigInteger('created_by').nullable();
        t.timestamps(true, true);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('stock_adjustments');
};
