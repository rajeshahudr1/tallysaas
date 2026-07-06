'use strict';
/** 20260101000055 — GUID-based uniqueness for synced payments (like invoices).
 *
 * Tally reuses receipt/payment voucher numbers, so the blanket
 * UNIQUE(company_id,type,voucher_no) dropped distinct vouchers. Replace it with
 * a partial index for cloud-created rows (the synced ones are already unique by
 * (company, tally_guid) via uq_payments_tally_guid from migration 0054). */
exports.up = async (knex) => {
    await knex.raw('ALTER TABLE payments DROP CONSTRAINT IF EXISTS uq_payments_company_type_no');
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_cloud_no
        ON payments (company_id, type, voucher_no) WHERE tally_guid IS NULL`);
};
exports.down = async (knex) => {
    await knex.raw('DROP INDEX IF EXISTS uq_payments_cloud_no');
    await knex.raw(`ALTER TABLE payments ADD CONSTRAINT uq_payments_company_type_no
        UNIQUE (company_id, type, voucher_no)`).catch(() => {});
};
