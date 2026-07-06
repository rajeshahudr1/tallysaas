'use strict';

/**
 * 20260101000013_create_categories.js
 *
 * categories — a tenant's product category tree (Tally stock groups).
 *
 * `parent_id` is a nullable SELF reference enabling an arbitrary-depth tree
 * (NULL parent = a top-level category). Deleting a parent SETs NULL on its
 * children rather than cascading, so a mis-delete never silently wipes a whole
 * sub-tree. Tenant-scoped (company_id) with soft-delete.
 *
 * Ordered before products (products.category_id FK). The self-FK is added
 * after table creation so the reference target exists.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('categories', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('name', 150).notNullable();

        // self-referential parent (nullable → top-level when NULL)
        t.bigInteger('parent_id')
            .nullable()
            .references('id').inTable('categories')
            .onDelete('SET NULL');

        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('company_id', 'idx_categories_company_id');
        t.index('parent_id',  'idx_categories_parent_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('categories');
};
