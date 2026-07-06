'use strict';

/**
 * 20260101000045_company_tally_fields.js
 *
 * Mirror Tally's company master EXACTLY: store every company field Tally gives
 * us in its OWN column instead of cramming state/pincode/country into one
 * `address` string (which the user could never cleanly split/edit later).
 *
 * Tally company master → columns:
 *   MAILINGNAME      → mailing_name
 *   STATENAME        → state
 *   COUNTRYNAME      → country
 *   PINCODE          → pincode
 *   PHONENUMBER      → phone        (mobile stays for MOBILENUMBERS)
 *   STARTINGFROM/    → books_from   (the books-beginning date, distinct from the
 *   BOOKSFROM           "2024-2025" financial_year label already stored)
 *
 * All nullable so existing rows stay valid; the agent fills them (empty-only) on
 * the next pull, and the company-admin can edit any of them in the web form.
 */

const COLS = [
    ['mailing_name', 'string'],
    ['state',        'string'],
    ['country',      'string'],
    ['pincode',      'string'],
    ['phone',        'string'],
    ['books_from',   'string'],
];

exports.up = async function up(knex) {
    for (const [col, type] of COLS) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await knex.schema.hasColumn('companies', col))) {
            // eslint-disable-next-line no-await-in-loop
            await knex.schema.alterTable('companies', (t) => { t[type](col); });
        }
    }
};

exports.down = async function down(knex) {
    for (const [col] of COLS) {
        // eslint-disable-next-line no-await-in-loop
        if (await knex.schema.hasColumn('companies', col)) {
            // eslint-disable-next-line no-await-in-loop
            await knex.schema.alterTable('companies', (t) => { t.dropColumn(col); });
        }
    }
};
