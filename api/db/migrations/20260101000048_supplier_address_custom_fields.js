'use strict';

/**
 * 20260101000048_supplier_address_custom_fields.js
 *
 * Bring suppliers in line with the customer module + Tally: a Tally ledger
 * (Sundry Creditor) carries a mailing ADDRESS, and the module standard wants a
 * Custom Fields tab. Add:
 *   • address       — the Tally ledger mailing address (the form had the field
 *                     but no column, so it silently dropped before).
 *   • custom_fields — JSONB key/value bag (mirrors companies/locations/customers).
 */

exports.up = async function up(knex) {
    const has = async (c) => knex.schema.hasColumn('suppliers', c);
    if (!(await has('address'))) {
        await knex.schema.alterTable('suppliers', (t) => t.text('address'));
    }
    if (!(await has('custom_fields'))) {
        await knex.schema.alterTable('suppliers', (t) => {
            t.jsonb('custom_fields').notNullable().defaultTo('{}');
        });
    }
};

exports.down = async function down(knex) {
    for (const c of ['address', 'custom_fields']) {
        // eslint-disable-next-line no-await-in-loop
        if (await knex.schema.hasColumn('suppliers', c)) {
            // eslint-disable-next-line no-await-in-loop
            await knex.schema.alterTable('suppliers', (t) => t.dropColumn(c));
        }
    }
};
