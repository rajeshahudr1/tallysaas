'use strict';

/**
 * 20260101000028_add_vchtype_to_journals.js
 *
 * Generalise the journals table into a two-ledger voucher: a `vch_type` selects
 * which Tally voucher it becomes — Journal | Contra | Credit Note | Debit Note.
 * All four share the same Dr-ledger / Cr-ledger / amount shape, so one
 * table + form + push path covers them.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('journals', (t) => {
        t.string('vch_type', 30).notNullable().defaultTo('Journal');
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('journals', (t) => {
        t.dropColumn('vch_type');
    });
};
