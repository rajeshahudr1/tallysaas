'use strict';
/** 20260101000050 — add tally_dirty to products (bidirectional edit re-push). */
exports.up = async (knex) => {
    if (!(await knex.schema.hasColumn('products', 'tally_dirty'))) {
        await knex.schema.alterTable('products', (t) => t.boolean('tally_dirty').notNullable().defaultTo(false));
    }
};
exports.down = async (knex) => {
    if (await knex.schema.hasColumn('products', 'tally_dirty')) {
        await knex.schema.alterTable('products', (t) => t.dropColumn('tally_dirty'));
    }
};
