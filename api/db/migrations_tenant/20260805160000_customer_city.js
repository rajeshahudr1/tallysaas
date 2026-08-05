'use strict';

/**
 * Adds `customers.city` — the last leg of the Country → State → City
 * cascade on the customer address form (country/state/pincode already exist,
 * see 20260805140000_customer_party_fields.js).
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('customers'))) return;
    if (await knex.schema.hasColumn('customers', 'city')) return;
    await knex.schema.alterTable('customers', (t) => {
        t.string('city', 120).nullable();
    });
};

exports.down = async function down(knex) {
    if (!(await knex.schema.hasTable('customers'))) return;
    if (!(await knex.schema.hasColumn('customers', 'city'))) return;
    await knex.schema.alterTable('customers', (t) => {
        t.dropColumn('city');
    });
};
