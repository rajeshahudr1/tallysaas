'use strict';

/**
 * 20260101000020_create_settings.js
 *
 * settings — per-company key/value configuration store.
 *
 * A simple, flexible bag of tenant settings (Tally connection params, invoice
 * numbering prefixes, feature flags, etc.). `value` is jsonb so callers may
 * store either a scalar or a structured blob. unique(company_id, key) makes
 * each key single-valued per tenant (upsert via ON CONFLICT). Spec keeps only
 * created_at/updated_at; no soft-delete (settings are overwritten in place).
 *
 * Ordered last; references only companies.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('settings', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('key', 120).notNullable();
        t.jsonb('value');

        t.timestamps(true, true);

        t.unique(['company_id', 'key'], 'uq_settings_company_key');
        t.index('company_id', 'idx_settings_company_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('settings');
};
