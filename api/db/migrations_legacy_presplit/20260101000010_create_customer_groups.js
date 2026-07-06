'use strict';

/**
 * 20260101000010_create_customer_groups.js
 *
 * customer_groups — a tenant's customer segmentation buckets
 * (e.g. Retail, Wholesale, Distributor).
 *
 * Customers optionally reference a group for pricing/reporting. Minimal table:
 * company_id + name + timestamps + soft-delete. Ordered before customers
 * because customers.customer_group_id references it.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('customer_groups', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('name', 150).notNullable();

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('company_id', 'idx_customer_groups_company_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('customer_groups');
};
