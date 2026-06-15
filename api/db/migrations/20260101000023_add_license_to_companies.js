'use strict';

/**
 * 20260101000023_add_license_to_companies.js
 *
 * One license → many companies. Nullable for backward compatibility with
 * companies created before the licensing layer.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('companies', (t) => {
        t.bigInteger('license_id').nullable()
            .references('id').inTable('licenses').onDelete('SET NULL');
        t.index(['license_id'], 'idx_companies_license');
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('companies', (t) => {
        t.dropIndex(['license_id'], 'idx_companies_license');
        t.dropColumn('license_id');
    });
};
