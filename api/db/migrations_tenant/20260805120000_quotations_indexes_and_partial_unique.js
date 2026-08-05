'use strict';

/**
 * Follow-up to 20260805100000_quotations.js (already applied — do not edit that file):
 *
 * 1. `quotations_company_no_uq` is a plain unique constraint on
 *    (company_id, quotation_no). Since quotations support soft delete
 *    (`deleted_at`), a soft-deleted quotation permanently blocks reuse of its
 *    number. Replace it with a partial unique index that only covers live
 *    rows (deleted_at IS NULL).
 * 2. Add listing indexes for the company + date-range + status filters used
 *    by the quotation list screen.
 * 3. Add an index on `converted_invoice_id` (used by the convert-to-invoice
 *    flow). No FK to `invoices`: quotations/quotation rows are soft-deleted
 *    (deleted_at) rather than hard-deleted, and invoices in this codebase
 *    are soft-deleted too, so an FK would need to tolerate references to
 *    soft-deleted invoice rows and would add no real integrity guarantee
 *    over the app-level check already done at conversion time — it would
 *    only risk conversion failures if invoice rows are ever purged/archived
 *    independently of quotations. An index without FK gives the lookup
 *    speed without that coupling.
 */

exports.up = async function up(knex) {
    const hasQuotations = await knex.schema.hasTable('quotations');
    if (!hasQuotations) return;

    // 1. Partial unique index replacing quotations_company_no_uq.
    const uqExists = await knex.raw(`
        SELECT 1 FROM pg_constraint WHERE conname = 'quotations_company_no_uq'
    `);
    if (uqExists.rows.length) {
        await knex.raw(`
            ALTER TABLE quotations DROP CONSTRAINT quotations_company_no_uq
        `);
    }
    await knex.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS quotations_company_no_live_uq
        ON quotations (company_id, quotation_no)
        WHERE deleted_at IS NULL
    `);

    // 2. Listing indexes.
    // Serves: list quotations for a company within a date range
    // (WHERE company_id = ? AND quotation_date BETWEEN ? AND ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS quotations_company_date_idx
        ON quotations (company_id, quotation_date)
    `);
    // Serves: list quotations for a company filtered by quote_status
    // (WHERE company_id = ? AND quote_status = ?).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS quotations_company_status_idx
        ON quotations (company_id, quote_status)
    `);

    // 3. converted_invoice_id lookup index (no FK — see comment above).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS quotations_converted_invoice_id_idx
        ON quotations (converted_invoice_id)
    `);
};

exports.down = async function down(knex) {
    const hasQuotations = await knex.schema.hasTable('quotations');
    if (!hasQuotations) return;

    await knex.raw(`DROP INDEX IF EXISTS quotations_converted_invoice_id_idx`);
    await knex.raw(`DROP INDEX IF EXISTS quotations_company_status_idx`);
    await knex.raw(`DROP INDEX IF EXISTS quotations_company_date_idx`);
    await knex.raw(`DROP INDEX IF EXISTS quotations_company_no_live_uq`);

    const uqExists = await knex.raw(`
        SELECT 1 FROM pg_constraint WHERE conname = 'quotations_company_no_uq'
    `);
    if (!uqExists.rows.length) {
        await knex.raw(`
            ALTER TABLE quotations
            ADD CONSTRAINT quotations_company_no_uq UNIQUE (company_id, quotation_no)
        `);
    }
};
