'use strict';

/**
 * 20260101000046_customer_custom_fields.js
 *
 * Add a `custom_fields` JSONB bag to customers (mirrors companies/locations,
 * migration 0044) so the customer form's Custom Fields tab can store arbitrary
 * key/value extras. Default '{}' keeps existing rows valid.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn('customers', 'custom_fields'))) {
        await knex.schema.alterTable('customers', (t) => {
            t.jsonb('custom_fields').notNullable().defaultTo('{}');
        });
    }
};

exports.down = async function down(knex) {
    if (await knex.schema.hasColumn('customers', 'custom_fields')) {
        await knex.schema.alterTable('customers', (t) => t.dropColumn('custom_fields'));
    }
};
