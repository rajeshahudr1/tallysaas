'use strict';

/**
 * 20260101000040_create_sales_person_customers.js
 *
 * sales_person_customers — the PER-LOCATION assignment of CUSTOMERS to a sales
 * person. A sales person who is also a login user (sales_persons.user_id) is
 * restricted to seeing ONLY the customers assigned here.
 *
 * Whereas sales_person_locations (migration 20260101000009) records WHICH
 * branches a sales person covers, this table records WHICH customers within
 * each of those branches they own. `location_id` is carried so the form can
 * manage assignments one location at a time (and so a customer that later moves
 * branch keeps an unambiguous assignment row).
 *
 * `company_id` is carried (denormalised) so the join itself is tenant-scoped
 * without an extra hop. unique(sales_person_id, customer_id, location_id)
 * prevents duplicate assignments. Every FK cascade-deletes so removing a sales
 * person, customer, location or company cleans up its assignment rows.
 *
 * Ordered after sales_persons (008), locations (005) and customers (011).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('sales_person_customers', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('sales_person_id')
            .notNullable()
            .references('id').inTable('sales_persons')
            .onDelete('CASCADE');

        t.bigInteger('customer_id')
            .notNullable()
            .references('id').inTable('customers')
            .onDelete('CASCADE');

        t.bigInteger('location_id')
            .notNullable()
            .references('id').inTable('locations')
            .onDelete('CASCADE');

        t.timestamps(true, true);

        t.unique(['sales_person_id', 'customer_id', 'location_id'], 'uq_spc_sp_customer_location');
        t.index('company_id',      'idx_spc_company_id');
        t.index('sales_person_id', 'idx_spc_sales_person_id');
        t.index('customer_id',     'idx_spc_customer_id');
        t.index('location_id',     'idx_spc_location_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('sales_person_customers');
};
