'use strict';

/**
 * 20260101000044_add_custom_fields.js
 *
 * The "Custom Fields" tab (Company + Location) was a "coming in next phase"
 * placeholder. This adds a `custom_fields` JSONB bag on both so a company-admin
 * can store arbitrary key/value extras (and, later, Tally company/godown UDFs can
 * be merged in here). Default '{}' so existing rows are valid.
 */

exports.up = async function up(knex) {
    const add = async (table) => {
        const has = await knex.schema.hasColumn(table, 'custom_fields');
        if (!has) {
            await knex.schema.alterTable(table, (t) => {
                t.jsonb('custom_fields').notNullable().defaultTo('{}');
            });
        }
    };
    await add('companies');
    await add('locations');
};

exports.down = async function down(knex) {
    for (const table of ['companies', 'locations']) {
        if (await knex.schema.hasColumn(table, 'custom_fields')) {
            await knex.schema.alterTable(table, (t) => t.dropColumn('custom_fields'));
        }
    }
};
