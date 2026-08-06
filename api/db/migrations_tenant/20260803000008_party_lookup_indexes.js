'use strict';

/**
 * Party-lookup indexes — invoices / payments by customer + supplier.
 *
 * Every "what does this party owe" query (dashboard Top 10, receivables
 * ageing, the ledger + outstanding screens) filters invoices/payments by
 * party id. Without these, Postgres seq-scanned invoices and payments once
 * per party: the dashboard's Top 10 panel alone cost ~3.5s on a 3k-customer
 * tenant. Partial (deleted_at IS NULL) since every one of those queries
 * excludes soft-deleted rows.
 */
exports.up = async function up(knex) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_invoices_customer
        ON invoices (company_id, customer_id, type) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_invoices_supplier
        ON invoices (company_id, supplier_id, type) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payments_customer
        ON payments (company_id, customer_id, type) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payments_supplier
        ON payments (company_id, supplier_id, type) WHERE deleted_at IS NULL`);
    // Inactive-stock anti-join walks invoice_items by product.
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_invoice_items_product
        ON invoice_items (company_id, product_id)`);
};

exports.down = async function down(knex) {
    await knex.raw('DROP INDEX IF EXISTS idx_invoices_customer');
    await knex.raw('DROP INDEX IF EXISTS idx_invoices_supplier');
    await knex.raw('DROP INDEX IF EXISTS idx_payments_customer');
    await knex.raw('DROP INDEX IF EXISTS idx_payments_supplier');
    await knex.raw('DROP INDEX IF EXISTS idx_invoice_items_product');
};
