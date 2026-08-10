'use strict';

/**
 * Starred parties.
 *
 * The Parties screen offers three views — All, Recent Active, Favourite. The
 * first two are derivable from data we already hold (every party; those with a
 * recent sale), but "Favourite" is a human judgement about which handful of
 * parties this business actually deals with day to day, and nothing in Tally
 * records it. It needs a column.
 *
 * Deliberately NOT per-user: a small trading business shares one shortlist,
 * and a per-user favourites table would mean the owner and the accountant see
 * different Parties screens over the same ledger. If that turns out to be
 * wrong, a join table can replace this column without touching the filter.
 */

async function addFlag(knex, table) {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, 'is_favourite')) return;
    await knex.schema.alterTable(table, (t) => {
        // NOT NULL default false: "not starred" is the honest answer for every
        // existing row, and a nullable flag would make the filter three-valued
        // for no reason.
        t.boolean('is_favourite').notNullable().defaultTo(false);
    });
    // The Favourite tab is a small slice of a large table, so it is worth an
    // index — but only over the starred rows, which are the few that matter.
    await knex.raw(
        `create index if not exists ${table}_favourite_idx
         on ${table} (company_id) where is_favourite`,
    );
}

exports.up = async function up(knex) {
    await addFlag(knex, 'customers');
    await addFlag(knex, 'suppliers');
};

exports.down = async function down(knex) {
    for (const table of ['customers', 'suppliers']) {
        if (!(await knex.schema.hasTable(table))) continue;
        await knex.raw(`drop index if exists ${table}_favourite_idx`);
        if (await knex.schema.hasColumn(table, 'is_favourite')) {
            await knex.schema.alterTable(table, (t) => t.dropColumn('is_favourite'));
        }
    }
};
