'use strict';

/**
 * Party activity log — the follow-up trail on a customer or supplier.
 *
 * "I called them, they said call back Tuesday" is the single most common thing
 * a collections team needs to remember, and it had nowhere to live: the party
 * screen could show what was BILLED but not what was SAID. Notes were ending
 * up in `internal_remarks`, a single overwritten text box with no date, no
 * author and no history.
 *
 * Each row is one interaction: an outcome, an optional note, an optional
 * follow-up date, and who logged it. Append-only in spirit — an activity is
 * a record of something that happened, so the UI offers no edit.
 */

const OUTCOMES = [
    'interested', 'not_interested', 'busy', 'call_back',
    'follow_up', 'meeting_scheduled', 'payment_promised', 'note',
];

exports.up = async function up(knex) {
    if (await knex.schema.hasTable('party_activities')) return;
    await knex.schema.createTable('party_activities', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().index();

        // Which side the party sits on. Customers and suppliers are separate
        // tables with their own id sequences, so the type is part of the key —
        // customer #7 and supplier #7 are different parties.
        t.string('party_type', 16).notNullable();   // 'customer' | 'supplier'
        t.bigInteger('party_id').notNullable();

        t.string('outcome', 32).notNullable();
        t.text('note').nullable();

        // When to come back to them. Nullable: plenty of interactions need no
        // follow-up, and a fabricated date would clutter every reminder list.
        t.date('follow_up_on').nullable();

        t.bigInteger('created_by').nullable();
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        // The party timeline is the only read path, and it is always newest
        // first — one index serves it.
        t.index(['company_id', 'party_type', 'party_id', 'created_at'],
            'party_activities_party_idx');
    });
};

exports.down = async function down(knex) {
    if (!(await knex.schema.hasTable('party_activities'))) return;
    await knex.schema.dropTable('party_activities');
};

exports.OUTCOMES = OUTCOMES;
