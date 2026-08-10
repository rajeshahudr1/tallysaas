'use strict';

/**
 * Credit period and tax classification on the synced Tally ledger.
 *
 * The agent has always FETCHED these (BILLCREDITPERIOD, TAXTYPE,
 * TAXCLASSIFICATIONNAME on the ledger collection) and parsed them, but the
 * upsert only kept name/parent/opening/closing/gstin — so they were thrown
 * away on every sync.
 *
 * Why they matter:
 *   • credit_period_days is the party's agreed credit term. Tally already
 *     knows it, yet the Parties screen had nowhere to read it from, so the
 *     Credit Days column was blank and the field had to be typed by hand.
 *     A due date derived from a hand-typed term is a due date nobody trusts.
 *   • tax_type / tax_classification say whether a sales ledger attracts GST
 *     and at what rate — the line the voucher form shows under each ledger
 *     option, so you can see what you are booking against before you pick it.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('tally_ledgers'))) return;
    const add = [];
    if (!(await knex.schema.hasColumn('tally_ledgers', 'credit_period_days'))) add.push('credit_period_days');
    if (!(await knex.schema.hasColumn('tally_ledgers', 'tax_type'))) add.push('tax_type');
    if (!(await knex.schema.hasColumn('tally_ledgers', 'tax_classification'))) add.push('tax_classification');
    if (!add.length) return;
    await knex.schema.alterTable('tally_ledgers', (t) => {
        // Nullable: "no agreed term" is a real answer and is not the same as 0.
        if (add.includes('credit_period_days')) t.integer('credit_period_days').nullable();
        if (add.includes('tax_type')) t.string('tax_type', 60).nullable();
        if (add.includes('tax_classification')) t.string('tax_classification', 120).nullable();
    });
};

exports.down = async function down(knex) {
    if (!(await knex.schema.hasTable('tally_ledgers'))) return;
    for (const col of ['credit_period_days', 'tax_type', 'tax_classification']) {
        if (await knex.schema.hasColumn('tally_ledgers', col)) {
            await knex.schema.alterTable('tally_ledgers', (t) => t.dropColumn(col));
        }
    }
};
