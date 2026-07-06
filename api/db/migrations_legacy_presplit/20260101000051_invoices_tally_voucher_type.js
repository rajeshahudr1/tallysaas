'use strict';
/** 20260101000051 — store the Tally voucher type on each invoice.
 *
 * Tally maps several voucher types onto cloud type='sales' (Sales, RETAIL CASH
 * SALES, UDAAN, Credit Note). Tally's Sales Register EXCLUDES Credit Notes
 * (sales returns live in their own register), so the cloud must know each
 * invoice's real Tally voucher type to reproduce the register exactly. */
exports.up = async (knex) => {
    if (!(await knex.schema.hasColumn('invoices', 'tally_voucher_type'))) {
        await knex.schema.alterTable('invoices', (t) => {
            t.string('tally_voucher_type', 64).nullable();
            t.index(['company_id', 'type', 'tally_voucher_type'], 'invoices_company_type_vtype_idx');
        });
    }
};
exports.down = async (knex) => {
    if (await knex.schema.hasColumn('invoices', 'tally_voucher_type')) {
        await knex.schema.alterTable('invoices', (t) => {
            t.dropIndex(['company_id', 'type', 'tally_voucher_type'], 'invoices_company_type_vtype_idx');
            t.dropColumn('tally_voucher_type');
        });
    }
};
