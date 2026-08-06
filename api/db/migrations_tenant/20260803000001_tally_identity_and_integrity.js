'use strict';

/**
 * Tenant migration 001 — Tally identity (GUID/MASTERID) + integrity.
 *
 * Two problems this fixes:
 *
 * 1) IDENTITY. Every Tally master was upserted on (company_id, name) and had its
 *    `tally_guid` stamped with the literal string 'tally'. So a rename in Tally
 *    produced a DUPLICATE cloud row, and a delete could never be detected — the
 *    real GUID/MASTERID were never stored. We add `tally_master_id` +
 *    `deleted_at` everywhere and make `tally_guid` a real identity column with a
 *    partial-unique index. Existing placeholder 'tally' values are cleared to
 *    NULL first (they carry no information) so the index can be created; the next
 *    sync backfills the genuine GUIDs.
 *
 * 2) INTEGRITY. tally_voucher_entries / tally_inventory_entries had no FK to
 *    companies and no unique constraint — idempotency relied entirely on the
 *    importer's delete-by-GUID, so two concurrent imports duplicated every line.
 *    We add line_no, a real unique key, and the missing FKs.
 *
 * Everything is guarded (IF NOT EXISTS / hasColumn) because a FRESH tenant runs
 * this straight after tenant-schema.sql, which already declares some of it.
 */

// Tally-sourced tables that need the full identity quartet.
const IDENTITY_TABLES = [
    'tally_groups', 'tally_ledgers',
    'customers', 'suppliers', 'products', 'locations', 'categories',
    'invoices', 'payments', 'journals',
];

exports.up = async function up(knex) {
    // ── 1. identity columns ──────────────────────────────────
    for (const table of IDENTITY_TABLES) {
        if (!(await knex.schema.hasTable(table))) continue;

        // Column-by-column: these tables already carry SOME of this set
        // (tally_alter_id on the tally_* mirrors, deleted_at on companies-like
        // tables), and a single alterTable would abort wholesale on the first
        // duplicate, silently skipping the columns that ARE missing.
        const add = async (col, build) => {
            if (await knex.schema.hasColumn(table, col)) return;
            await knex.schema.alterTable(table, build);
        };
        await add('tally_master_id', (t) => t.bigInteger('tally_master_id').nullable());
        await add('tally_alter_id',  (t) => t.bigInteger('tally_alter_id').defaultTo(0));
        await add('deleted_at',      (t) => t.timestamp('deleted_at', { useTz: true }).nullable());
        // `categories` never had a guid column at all; the others do (varying widths).
        await add('tally_guid',      (t) => t.string('tally_guid', 120).nullable());
        // Widen the narrower ones — a Tally GUID is "<company-guid>-<seq>" and can
        // exceed the 80/100 some of these were declared with.
        await knex.raw(`ALTER TABLE ?? ALTER COLUMN tally_guid TYPE varchar(120)`, [table]).catch(() => {});

        // Placeholder guids carry no identity — clear them so the unique index can
        // be built and so the importer treats these rows as "guid not yet known".
        await knex(table).where('tally_guid', 'tally').update({ tally_guid: null });

        // Partial-unique: rows that predate GUID capture (NULL) stay legal.
        await knex.raw(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_tally_guid_uq
             ON ${table} (company_id, tally_guid) WHERE tally_guid IS NOT NULL`,
        ).catch(() => {});
        await knex.raw(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_tally_master_id_uq
             ON ${table} (company_id, tally_master_id) WHERE tally_master_id IS NOT NULL`,
        ).catch(() => {});
        await knex.raw(
            `CREATE INDEX IF NOT EXISTS ${table}_deleted_at_idx ON ${table} (company_id, deleted_at)`,
        ).catch(() => {});
    }

    // ── 2. voucher line integrity ────────────────────────────
    if (await knex.schema.hasTable('tally_voucher_entries')) {
        await knex.schema.alterTable('tally_voucher_entries', (t) => {
            t.integer('line_no').notNullable().defaultTo(0);
        }).catch(() => {});
        // Pre-existing rows all share line_no 0, which would break the unique key.
        // Number them deterministically by insertion order within each voucher.
        await knex.raw(`
            WITH numbered AS (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, voucher_guid ORDER BY id) - 1 AS n
                FROM tally_voucher_entries
            )
            UPDATE tally_voucher_entries e SET line_no = numbered.n
            FROM numbered WHERE numbered.id = e.id AND e.line_no = 0
        `);
        await knex.raw(`
            CREATE UNIQUE INDEX IF NOT EXISTS tally_voucher_entries_line_uq
            ON tally_voucher_entries (company_id, voucher_guid, line_no)
        `);
    }

    if (await knex.schema.hasTable('tally_inventory_entries')) {
        await knex.schema.alterTable('tally_inventory_entries', (t) => {
            t.integer('line_no').notNullable().defaultTo(0);
        }).catch(() => {});
        await knex.raw(`
            WITH numbered AS (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, voucher_guid ORDER BY id) - 1 AS n
                FROM tally_inventory_entries
            )
            UPDATE tally_inventory_entries e SET line_no = numbered.n
            FROM numbered WHERE numbered.id = e.id AND e.line_no = 0
        `);
        await knex.raw(`
            CREATE UNIQUE INDEX IF NOT EXISTS tally_inventory_entries_line_uq
            ON tally_inventory_entries (company_id, voucher_guid, line_no)
        `);
    }

    // Missing FKs to companies. Orphan rows (company deleted while lines lingered)
    // are cleared first or ADD CONSTRAINT would fail.
    for (const table of ['tally_voucher_entries', 'tally_inventory_entries', 'tally_groups', 'tally_ledgers']) {
        if (!(await knex.schema.hasTable(table))) continue;
        // Orphans are rows whose company was deleted — unreachable, since every
        // app query scopes by company_id. They must go before ADD CONSTRAINT.
        // Reported loudly rather than dropped quietly: on a real fleet this
        // number is the operator's cue that a company was removed under them.
        const { rows: [{ count }] } = await knex.raw(
            `SELECT count(*)::int AS count FROM ${table} WHERE company_id NOT IN (SELECT id FROM companies)`,
        );
        if (count > 0) console.warn(`  ! ${table}: deleting ${count} orphan row(s) (company no longer exists)`);
        await knex.raw(`DELETE FROM ${table} WHERE company_id NOT IN (SELECT id FROM companies)`);
        await knex.raw(`
            DO $$ BEGIN
                ALTER TABLE ${table}
                    ADD CONSTRAINT ${table}_company_id_fk
                    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);
    }

    // journals had no unique on its guid — dedup was code-only.
    if (await knex.schema.hasTable('journals')) {
        await knex.raw(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_journals_tally_guid
            ON journals (company_id, tally_guid) WHERE tally_guid IS NOT NULL
        `).catch(() => {});
    }
};

exports.down = async function down(knex) {
    for (const table of IDENTITY_TABLES) {
        if (!(await knex.schema.hasTable(table))) continue;
        await knex.raw(`DROP INDEX IF EXISTS ${table}_tally_guid_uq`);
        await knex.raw(`DROP INDEX IF EXISTS ${table}_tally_master_id_uq`);
        await knex.raw(`DROP INDEX IF EXISTS ${table}_deleted_at_idx`);
        await knex.schema.alterTable(table, (t) => {
            t.dropColumn('tally_master_id');
            t.dropColumn('deleted_at');
        }).catch(() => {});
    }
    await knex.raw('DROP INDEX IF EXISTS tally_voucher_entries_line_uq');
    await knex.raw('DROP INDEX IF EXISTS tally_inventory_entries_line_uq');
    await knex.raw('DROP INDEX IF EXISTS uq_journals_tally_guid');
    for (const table of ['tally_voucher_entries', 'tally_inventory_entries', 'tally_groups', 'tally_ledgers']) {
        await knex.raw(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${table}_company_id_fk`);
    }
};
