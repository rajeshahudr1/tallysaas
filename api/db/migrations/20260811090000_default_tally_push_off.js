'use strict';

/**
 * Cloud→Tally auto-push defaults to OFF for a NEW licence.
 *
 * Pushing writes into the customer's real books. Getting that wrong is not a
 * bug you fix by editing a row — it is vouchers in someone's accounts that
 * were never meant to be there. So the safe state has to be the one you get
 * by doing nothing, and turning it on has to be a decision somebody made.
 *
 * provisionLicense() already inserts false explicitly, so today's creation
 * path is safe; this covers every OTHER way a row can appear — a restore, a
 * hand-written INSERT, a future controller that forgets the column.
 *
 * ONLY the default changes. Existing rows are left exactly as they are: this
 * migration must never flip a live licence's sync behaviour, in either
 * direction — a customer who deliberately turned push ON would otherwise find
 * it silently off after a deploy.
 *
 * PULL (Tally→cloud) keeps its default of ON: reading a customer's books
 * changes nothing in them, and an agent that pulls nothing looks broken.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.boolean('sync_push_enabled').notNullable().defaultTo(false).alter();
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.boolean('sync_push_enabled').notNullable().defaultTo(true).alter();
    });
};
