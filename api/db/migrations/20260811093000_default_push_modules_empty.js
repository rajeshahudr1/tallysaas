'use strict';

/**
 * A NEW licence starts with NO module selected for Cloud→Tally auto-push.
 *
 * The second lock, behind 20260811090000_default_tally_push_off. That one
 * makes push start OFF; this one decides what happens the moment somebody
 * turns it ON. Until now the answer was "everything at once": the column was
 * NULL, and NULL means ALL modules (see Helpers/syncModules.parseModules) —
 * so one click would begin writing invoices, payments, ledgers, notes, the
 * lot, into a customer's real books.
 *
 * Defaulting to '[]' — an explicit empty selection — makes turning push on a
 * safe act on its own: nothing moves until the operator names a module. The
 * usual first step, pushing ONE module to see it land correctly in Tally,
 * becomes the natural thing to do rather than something you have to know to
 * do first.
 *
 * NULL keeps meaning ALL. That is what every existing licence relies on, and
 * this migration deliberately leaves existing rows untouched: it changes what
 * a NEW row starts with, never what a live one already does.
 *
 * PULL is left alone — see the note in the previous migration.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.text('sync_push_modules').defaultTo('[]').alter();
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.text('sync_push_modules').defaultTo(null).alter();
    });
};
