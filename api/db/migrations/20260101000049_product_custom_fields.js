'use strict';
/** 20260101000049 — add custom_fields JSONB to products (module standard). */
exports.up = async (knex) => {
    if (!(await knex.schema.hasColumn('products', 'custom_fields'))) {
        await knex.schema.alterTable('products', (t) => t.jsonb('custom_fields').notNullable().defaultTo('{}'));
    }
};
exports.down = async (knex) => {
    if (await knex.schema.hasColumn('products', 'custom_fields')) {
        await knex.schema.alterTable('products', (t) => t.dropColumn('custom_fields'));
    }
};
