'use strict';

/**
 * 20260101000062_create_product_images.js
 *
 * product_images — multiple images per product, stored on the API's local disk
 * (uploads/products/<company>/<file>). These live ONLY in the cloud app; they are
 * NOT synced to Tally (Tally has no stock-item image field). `file_path` is the
 * path RELATIVE to the /uploads static mount — the API turns it into an absolute
 * URL in responses so web + app never build paths themselves.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('product_images', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('product_id').notNullable()
            .references('id').inTable('products').onDelete('CASCADE');

        t.string('file_path', 255).notNullable();   // relative: products/<company>/<file>
        t.string('original_name', 191);
        t.integer('size_bytes');
        t.string('mime', 60);
        t.integer('sort_order').notNullable().defaultTo(0);

        t.bigInteger('created_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'product_id'], 'idx_product_images_product');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('product_images');
};
