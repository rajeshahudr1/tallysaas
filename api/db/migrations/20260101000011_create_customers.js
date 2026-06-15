'use strict';

/**
 * 20260101000011_create_customers.js
 *
 * customers — a tenant's customer ledgers (Tally "sundry debtors").
 *
 * Each customer belongs to a company and may optionally be tagged with a home
 * `location_id`, an attributed `sales_person_id`, and a `customer_group_id`.
 * Money columns use numeric(14,2). `is_tally_ledger` defaults true so the
 * record is eligible to sync as a Tally ledger; `tally_guid`/`tally_synced_at`
 * track the linkage. `notes` is customer-visible; `internal_remarks` is staff-only.
 *
 * Ordered after locations, sales_persons and customer_groups (all FK targets).
 * This is the table the sample CRUD controller exercises.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('customers', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('location_id')
            .nullable()
            .references('id').inTable('locations')
            .onDelete('SET NULL');

        t.bigInteger('sales_person_id')
            .nullable()
            .references('id').inTable('sales_persons')
            .onDelete('SET NULL');

        t.bigInteger('customer_group_id')
            .nullable()
            .references('id').inTable('customer_groups')
            .onDelete('SET NULL');

        t.string('name', 191).notNullable();
        t.string('mobile', 30);
        t.string('alternate_mobile', 30);
        t.string('email', 191);
        t.string('gst_number', 30);
        t.string('pan_number', 20);
        t.text('billing_address');
        t.text('shipping_address');

        t.decimal('opening_balance', 14, 2).notNullable().defaultTo(0);
        t.decimal('credit_limit',    14, 2).notNullable().defaultTo(0);

        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive | Blocked
        t.boolean('is_tally_ledger').notNullable().defaultTo(true);
        t.string('tally_guid', 100);
        t.timestamp('tally_synced_at', { useTz: true });

        t.text('notes');
        t.text('internal_remarks');

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'status'],      'idx_customers_company_status');
        t.index(['company_id', 'location_id'], 'idx_customers_company_location');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('customers');
};
