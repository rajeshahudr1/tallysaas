'use strict';

/**
 * 20260101000015_create_inventory.js
 *
 * inventory — per-product, per-location stock position.
 *
 * One row tracks the running stock of a product at a location:
 *   current_stock = opening + purchased - sold
 * `value` (numeric 16,2) is the valuation of that stock; `reorder_level` flags
 * low stock. unique(company_id, product_id, location_id) guarantees a single
 * ledger row per product/location pair (location_id NULL = company-wide pool).
 *
 * Per spec this table keeps created_at/updated_at but NO soft-delete (stock
 * rows are corrected in place, never tombstoned). Ordered after products and
 * locations.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('inventory', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('product_id')
            .notNullable()
            .references('id').inTable('products')
            .onDelete('CASCADE');

        t.bigInteger('location_id')
            .nullable()
            .references('id').inTable('locations')
            .onDelete('SET NULL');

        t.decimal('opening',       14, 2).notNullable().defaultTo(0);
        t.decimal('purchased',     14, 2).notNullable().defaultTo(0);
        t.decimal('sold',          14, 2).notNullable().defaultTo(0);
        t.decimal('current_stock', 14, 2).notNullable().defaultTo(0);
        t.decimal('value',         16, 2).notNullable().defaultTo(0);
        t.decimal('reorder_level', 14, 2).notNullable().defaultTo(0);

        t.text('status').notNullable().defaultTo('Active');

        t.timestamps(true, true);

        t.unique(['company_id', 'product_id', 'location_id'], 'uq_inventory_company_product_location');
        t.index('company_id', 'idx_inventory_company_id');
        t.index('product_id', 'idx_inventory_product_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('inventory');
};
