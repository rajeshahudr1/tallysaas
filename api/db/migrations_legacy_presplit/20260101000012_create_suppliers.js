'use strict';

/**
 * 20260101000012_create_suppliers.js
 *
 * suppliers — a tenant's supplier ledgers (Tally "sundry creditors").
 *
 * Mirrors customers on the purchase side. `supplier_group` is a free-text
 * bucket (suppliers are typically fewer, so no separate groups table).
 * `payment_terms` records the agreed credit terms. `opening_balance` is
 * numeric(14,2). `is_tally_ledger` defaults true. Tenant-scoped, soft-delete.
 *
 * Ordered after locations (location_id FK).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('suppliers', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('location_id')
            .nullable()
            .references('id').inTable('locations')
            .onDelete('SET NULL');

        t.string('supplier_group', 100);
        t.string('name', 191).notNullable();
        t.string('mobile', 30);
        t.string('alternate_mobile', 30);
        t.string('email', 191);
        t.string('gst_number', 30);
        t.string('pan_number', 20);

        t.decimal('opening_balance', 14, 2).notNullable().defaultTo(0);
        t.string('payment_terms', 100);

        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive | Blocked
        t.boolean('is_tally_ledger').notNullable().defaultTo(true);
        t.string('tally_guid', 100);
        t.timestamp('tally_synced_at', { useTz: true });

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'status'], 'idx_suppliers_company_status');
        t.index('company_id',             'idx_suppliers_company_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('suppliers');
};
