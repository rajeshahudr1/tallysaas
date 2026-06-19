'use strict';
/** 20260101000054 — give payments the same Tally identity columns as invoices.
 *
 * payments (receipts/payments) had no tally_guid, so the import could not dedup
 * by the real voucher identity (it used voucher_no, which Tally reuses) and the
 * register could not reconstruct a voucher from tally_voucher_entries. Add
 * tally_guid (+ a GUID-unique partial index) and tally_optional, mirroring the
 * invoices fix (migrations 0052/0053). */
exports.up = async (knex) => {
    const hasGuid = await knex.schema.hasColumn('payments', 'tally_guid');
    const hasOpt = await knex.schema.hasColumn('payments', 'tally_optional');
    if (!hasGuid || !hasOpt) {
        await knex.schema.alterTable('payments', (t) => {
            if (!hasGuid) t.string('tally_guid', 80).nullable();
            if (!hasOpt) t.boolean('tally_optional').notNullable().defaultTo(false);
        });
    }
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tally_guid
        ON payments (company_id, tally_guid) WHERE tally_guid IS NOT NULL`);
};
exports.down = async (knex) => {
    await knex.raw('DROP INDEX IF EXISTS uq_payments_tally_guid');
    if (await knex.schema.hasColumn('payments', 'tally_guid')) {
        await knex.schema.alterTable('payments', (t) => t.dropColumn('tally_guid'));
    }
    if (await knex.schema.hasColumn('payments', 'tally_optional')) {
        await knex.schema.alterTable('payments', (t) => t.dropColumn('tally_optional'));
    }
};
