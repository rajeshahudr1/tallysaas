'use strict';

/**
 * 20260101000014_create_products.js
 *
 * products — a tenant's stock items (Tally stock items).
 *
 * Belongs to a company and optionally a category. `sku` is the stock keeping
 * unit; `hsn_code`/`gst_rate` drive tax; `purchase_price`/`sales_price` are the
 * default rates; `opening_stock` is the launch quantity. `is_tally_item`
 * defaults true to flag the item for Tally sync. Money = numeric(14,2),
 * gst_rate = numeric(5,2). Tenant-scoped with soft-delete.
 *
 * Ordered after categories (category_id FK).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('products', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('category_id')
            .nullable()
            .references('id').inTable('categories')
            .onDelete('SET NULL');

        t.string('name', 191).notNullable();
        t.string('sku', 100);
        t.string('unit', 30);                                   // PCS, KG, BOX ...
        t.string('hsn_code', 20);
        t.decimal('gst_rate', 5, 2).notNullable().defaultTo(0);

        t.decimal('purchase_price', 14, 2).notNullable().defaultTo(0);
        t.decimal('sales_price',    14, 2).notNullable().defaultTo(0);
        t.decimal('opening_stock',  14, 2).notNullable().defaultTo(0);

        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive
        t.boolean('is_tally_item').notNullable().defaultTo(true);
        t.string('tally_guid', 100);
        t.timestamp('tally_synced_at', { useTz: true });

        t.text('description');

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('company_id',          'idx_products_company_id');
        t.index(['company_id', 'sku'], 'idx_products_company_sku');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('products');
};
