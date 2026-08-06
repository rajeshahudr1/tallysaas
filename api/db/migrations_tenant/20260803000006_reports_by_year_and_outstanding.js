'use strict';

/**
 * Tenant migration 006 — per-financial-year reports + Tally's own outstanding.
 *
 * 1) tally_reports was unique on (company_id, report_type), so every sync
 *    OVERWROTE the single stored Balance Sheet. Two consequences: last year's
 *    statement could never be shown, and — worse — nothing recorded WHICH period
 *    the stored figures covered, so a report pulled while Tally sat on a
 *    different period was indistinguishable from a current one. We add the
 *    financial year and widen the unique key to include it.
 *
 *    Existing rows are backfilled to fy '' — the "current period, undated pull"
 *    bucket the agent still writes and the existing screens still read. So this
 *    is additive: nothing that reads tally_reports today changes behaviour.
 *
 * 2) tally_outstanding_bills stores Tally's OWN Bills Receivable / Payable, bill
 *    by bill. The cloud continues to DERIVE outstanding from the mirrored bill
 *    allocations — this is the independent second opinion to check that against.
 *    Without it a derived figure that has drifted looks exactly like one that is
 *    correct, because there is nothing to compare it to.
 */

exports.up = async function up(knex) {
    // ── 1. tally_reports: add the financial year ─────────────
    if (await knex.schema.hasTable('tally_reports')) {
        if (!(await knex.schema.hasColumn('tally_reports', 'fy'))) {
            await knex.schema.alterTable('tally_reports', (t) => {
                // '' = the undated "current period" pull, which is what every
                // existing row is. NOT NULL so the unique key below can never be
                // defeated by a NULL (in postgres NULLs are distinct, so a
                // nullable column here would let duplicates back in).
                t.string('fy', 12).notNullable().defaultTo('');
                t.date('period_from').nullable();
                t.date('period_to').nullable();
            });
        }
        // Swap the unique key to include fy. Drop first: the old one would
        // reject the second year of any report.
        await knex.raw('ALTER TABLE tally_reports DROP CONSTRAINT IF EXISTS uq_tally_reports_company_type')
            .catch(() => {});
        await knex.raw('DROP INDEX IF EXISTS uq_tally_reports_company_type').catch(() => {});
        await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tally_reports_company_type_fy
                        ON tally_reports (company_id, report_type, fy)`);
    }

    // ── 2. Tally's own bill-wise outstanding ─────────────────
    if (!(await knex.schema.hasTable('tally_outstanding_bills'))) {
        await knex.schema.createTable('tally_outstanding_bills', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            // 'receivable' | 'payable' — Tally reports them separately and a bill
            // can legitimately exist on both sides for the same party.
            t.string('side', 12).notNullable();
            t.string('fy', 12).notNullable().defaultTo('');
            t.string('party', 255).notNullable();
            t.string('bill', 255).notNullable().defaultTo('');
            t.date('bill_date').nullable();
            t.date('due_date').nullable();
            t.decimal('amount', 18, 2).notNullable().defaultTo(0);
            t.integer('overdue_days').notNullable().defaultTo(0);
            t.timestamp('synced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

            // A party can carry several bills with the SAME reference across
            // periods, so the key includes the date — without it Tally's own
            // duplicate refs would silently collapse into one row and under-report.
            t.unique(['company_id', 'side', 'fy', 'party', 'bill', 'bill_date'],
                { indexName: 'uq_tally_outstanding_bill' });
            t.index(['company_id', 'side'], 'tally_outstanding_side_idx');
            t.index(['company_id', 'party'], 'tally_outstanding_party_idx');
            t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('tally_outstanding_bills');
    if (await knex.schema.hasTable('tally_reports')) {
        await knex.raw('DROP INDEX IF EXISTS uq_tally_reports_company_type_fy').catch(() => {});
        await knex.schema.alterTable('tally_reports', (t) => {
            t.dropColumn('fy'); t.dropColumn('period_from'); t.dropColumn('period_to');
        }).catch(() => {});
        await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tally_reports_company_type
                        ON tally_reports (company_id, report_type)`).catch(() => {});
    }
};
