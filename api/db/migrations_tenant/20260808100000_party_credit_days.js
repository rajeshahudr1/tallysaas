'use strict';

/**
 * Credit period, in days, on the party master.
 *
 * The Parties list reports Credit Limit AND Credit Days side by side — the
 * limit caps how much a party may owe, the period caps how long. We already
 * stored the limit but had nowhere to keep the period, so the column could not
 * be shown at all and a bill's due date had to be typed by hand every time.
 *
 * Nullable on purpose: NULL means "no agreed terms", which is not the same as
 * 0 days. A voucher form reads NULL as "no default due date", and the Parties
 * list prints a dash rather than claiming the party was granted zero credit.
 */

exports.up = async function up(knex) {
    for (const table of ['customers', 'suppliers']) {
        if (!(await knex.schema.hasTable(table))) continue;
        if (await knex.schema.hasColumn(table, 'credit_days')) continue;
        await knex.schema.alterTable(table, (t) => {
            t.integer('credit_days').nullable();
        });
    }
};

exports.down = async function down(knex) {
    for (const table of ['customers', 'suppliers']) {
        if (!(await knex.schema.hasTable(table))) continue;
        if (!(await knex.schema.hasColumn(table, 'credit_days'))) continue;
        await knex.schema.alterTable(table, (t) => {
            t.dropColumn('credit_days');
        });
    }
};
