'use strict';
/** 20260101000053 — make invoice uniqueness GUID-based for Tally-synced rows.
 *
 * Tally vouchers REUSE numbers (purchase bills especially: different suppliers /
 * dates carry the same bill no), so a blanket UNIQUE(company_id,type,invoice_no)
 * wrongly drops distinct synced vouchers. Replace it with two partial indexes:
 *   • cloud-created invoices (tally_guid NULL) keep a unique number, and
 *   • synced invoices are unique by their Tally GUID (the real voucher identity).
 */
exports.up = async (knex) => {
    await knex.raw('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS uq_invoices_company_type_no');
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_cloud_no
        ON invoices (company_id, type, invoice_no) WHERE tally_guid IS NULL`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_tally_guid
        ON invoices (company_id, tally_guid) WHERE tally_guid IS NOT NULL`);
};
exports.down = async (knex) => {
    await knex.raw('DROP INDEX IF EXISTS uq_invoices_cloud_no');
    await knex.raw('DROP INDEX IF EXISTS uq_invoices_tally_guid');
    // Best-effort restore (fails if synced invoice_no duplicates now exist).
    await knex.raw(`ALTER TABLE invoices ADD CONSTRAINT uq_invoices_company_type_no
        UNIQUE (company_id, type, invoice_no)`).catch(() => {});
};
