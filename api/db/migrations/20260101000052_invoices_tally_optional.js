'use strict';
/** 20260101000052 — flag Tally "Optional" / "Cancelled" vouchers on invoices.
 *
 * Tally's OPTIONAL vouchers are unposted drafts and CANCELLED vouchers carry no
 * value; both are EXCLUDED from Tally's Sales/Purchase Register even though they
 * show in the Day Book. The cloud imports them as invoices, so it must flag them
 * to reproduce the register totals exactly (one optional Sales voucher was the
 * entire residual on one month). */
exports.up = async (knex) => {
    if (!(await knex.schema.hasColumn('invoices', 'tally_optional'))) {
        await knex.schema.alterTable('invoices', (t) => {
            t.boolean('tally_optional').notNullable().defaultTo(false);
        });
    }
};
exports.down = async (knex) => {
    if (await knex.schema.hasColumn('invoices', 'tally_optional')) {
        await knex.schema.alterTable('invoices', (t) => t.dropColumn('tally_optional'));
    }
};
