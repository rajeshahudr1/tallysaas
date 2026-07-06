'use strict';

/**
 * 20260101000034_perf_indexes.js — performance indexes for the hot paths.
 *
 * The base tables are already well-indexed on (company_id, status/type/date).
 * These add the ones the Tally SYNC path hammers that a plain B-tree can't serve:
 *   • FUNCTIONAL lower(name) per company — the agent import dedupes every ledger/
 *     stock/godown by `whereRaw('lower(name)=?')`, which can't use the name index.
 *   • (company_id, tally_voucher_no) — voucher idempotency/dedup lookups.
 *   • (company_id, created_at) on sync logs — the notification 24h window.
 * All CREATE/DROP ... IF [NOT] EXISTS so the migration is safe + idempotent.
 */

const LNAME = ['customers', 'suppliers', 'products', 'locations', 'categories'];

exports.up = async (knex) => {
    for (const t of LNAME) {
        await knex.raw(
            `CREATE INDEX IF NOT EXISTS idx_${t}_company_lname `
            + `ON ${t} (company_id, lower(name)) WHERE deleted_at IS NULL`,
        );
    }
    await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_invoices_company_tvno '
        + 'ON invoices (company_id, tally_voucher_no) WHERE deleted_at IS NULL',
    );
    await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_payments_company_tvno '
        + 'ON payments (company_id, tally_voucher_no) WHERE deleted_at IS NULL',
    );
    await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_synclogs_company_created '
        + 'ON tally_sync_logs (company_id, created_at)',
    );
};

exports.down = async (knex) => {
    for (const t of LNAME) {
        await knex.raw(`DROP INDEX IF EXISTS idx_${t}_company_lname`);
    }
    await knex.raw('DROP INDEX IF EXISTS idx_invoices_company_tvno');
    await knex.raw('DROP INDEX IF EXISTS idx_payments_company_tvno');
    await knex.raw('DROP INDEX IF EXISTS idx_synclogs_company_created');
};
