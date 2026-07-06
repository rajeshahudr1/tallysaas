'use strict';

/**
 * 20260101000005_create_locations.js
 *
 * locations — a tenant's branches / godowns / billing points.
 *
 * Every location belongs to exactly one company (company_id FK). When
 * `is_tally_godown` is true the location maps to a Tally godown for stock
 * synchronisation; `tally_guid` / `tally_synced_at` track that linkage.
 *
 * Ordered ahead of users in the migration sequence because users.location_id
 * references this table. Tenant-scoped → carries company_id + soft-delete.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('locations', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('name', 150).notNullable();
        t.string('code', 50);
        t.string('city', 100);
        t.string('state', 100);
        t.string('pincode', 12);
        t.string('mobile', 30);
        t.string('manager', 150);
        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive

        t.boolean('is_tally_godown').notNullable().defaultTo(false);
        t.string('tally_guid', 100);
        t.timestamp('tally_synced_at', { useTz: true });

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('company_id', 'idx_locations_company_id');
        t.index(['company_id', 'status'], 'idx_locations_company_status');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('locations');
};
