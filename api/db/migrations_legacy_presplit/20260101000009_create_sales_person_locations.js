'use strict';

/**
 * 20260101000009_create_sales_person_locations.js
 *
 * sales_person_locations — many-to-many between sales_persons and locations.
 *
 * Lets a single sales person cover several branches and a branch be served by
 * several sales persons. `company_id` is carried (denormalised) so the join
 * itself is tenant-scoped without an extra hop. unique(sales_person_id,
 * location_id) prevents duplicate assignments. Both FKs cascade-delete so a
 * removed sales person or location cleans up its assignment rows.
 *
 * Ordered after sales_persons and locations.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('sales_person_locations', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('sales_person_id')
            .notNullable()
            .references('id').inTable('sales_persons')
            .onDelete('CASCADE');

        t.bigInteger('location_id')
            .notNullable()
            .references('id').inTable('locations')
            .onDelete('CASCADE');

        t.timestamps(true, true);

        t.unique(['sales_person_id', 'location_id'], 'uq_spl_sales_person_location');
        t.index('company_id',      'idx_spl_company_id');
        t.index('sales_person_id', 'idx_spl_sales_person_id');
        t.index('location_id',     'idx_spl_location_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('sales_person_locations');
};
