'use strict';

/**
 * 20260101000001_create_companies.js
 *
 * companies — the tenant root table for TallySaaS.
 *
 * This is a SINGLE shared PostgreSQL database; multi-tenancy is enforced by a
 * `company_id` column on every other (tenant) table that references this one.
 * `companies` itself is therefore NOT company-scoped — each row here IS a
 * tenant. The `slug` is the URL-safe handle; `email`/`mobile` are the primary
 * contact channels; `status` gates login (Active / Inactive / Blocked).
 *
 * All timestamps are TIMESTAMPTZ stored in UTC (the pool afterCreate hook in
 * knexfile.js issues `SET timezone='UTC'`). Soft-delete is handled via the
 * nullable `deleted_at` column; queries filter `whereNull('deleted_at')`.
 *
 * Order note: this is migration #1 because nearly every other table FKs to it.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('companies', (t) => {
        t.bigIncrements('id').primary();

        t.string('name', 191).notNullable();
        t.string('slug', 120).notNullable().unique();           // URL-safe handle
        t.string('email', 191);
        t.string('mobile', 30);
        t.string('gst_number', 30);
        t.string('pan_number', 20);
        t.text('logo');                                         // path / url to logo
        t.text('address');
        t.string('financial_year', 20);                         // e.g. '2024-2025'

        // Lifecycle status — text enum with a default. Login is blocked unless Active.
        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive | Blocked

        t.string('subscription_plan', 60);
        t.timestamp('subscription_expires_at', { useTz: true });

        // created_at + updated_at TIMESTAMPTZ default now()
        t.timestamps(true, true);
        // soft-delete marker
        t.timestamp('deleted_at', { useTz: true }).nullable();

        // Lookup indexes used by login (slug), super-admin listing (status),
        // and the soft-delete filter (deleted_at).
        t.index('slug',       'idx_companies_slug');
        t.index('status',     'idx_companies_status');
        t.index('deleted_at', 'idx_companies_deleted_at');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('companies');
};
