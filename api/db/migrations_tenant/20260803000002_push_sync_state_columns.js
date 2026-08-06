'use strict';

/**
 * Tenant migration 002 — separate "has been pushed" from "Tally identity".
 *
 * The push path used `tally_guid` for BOTH jobs: /pending treated
 * `tally_guid IS NULL` as "not yet in Tally", so result() had to stamp
 * SOMETHING on success — and since a Tally master-import response does not
 * return the new master's GUID, the agent invented the literal strings
 * 'synced' / 'tally'. That poisoned the column (migration 001 had to clear
 * 3,584 of them per licence) and, now that (company_id, tally_guid) is unique,
 * a second pushed record would outright fail to stamp.
 *
 * Split the two concerns:
 *   • tally_synced_at  — "this row has reached Tally" (drives /pending)
 *   • tally_dirty      — "edited since; re-push as Alter"
 *   • tally_guid       — the REAL Tally GUID, and only ever that. It arrives on
 *     the next PULL cycle, which fetches GUID for every master.
 *
 * customers / suppliers / products / locations already had the first two.
 * companies and categories did not, which is why those two re-pushed forever.
 */

exports.up = async function up(knex) {
    for (const table of ['companies', 'categories']) {
        if (!(await knex.schema.hasTable(table))) continue;
        if (!(await knex.schema.hasColumn(table, 'tally_synced_at'))) {
            await knex.schema.alterTable(table, (t) => t.timestamp('tally_synced_at', { useTz: true }).nullable());
        }
        if (!(await knex.schema.hasColumn(table, 'tally_dirty'))) {
            await knex.schema.alterTable(table, (t) => t.boolean('tally_dirty').notNullable().defaultTo(false));
        }
    }

    // Backfill: rows that already carry a guid (real or the cleared placeholder's
    // former owners) have demonstrably been through Tally at least once. For
    // companies, `tally_guid IS NOT NULL` was the old "exists in Tally" test —
    // preserve that meaning so migrating does not re-push every company.
    // Migration 001 nulled the placeholders, so fall back to "has Tally data".
    if (await knex.schema.hasTable('companies')) {
        await knex.raw(`
            UPDATE companies SET tally_synced_at = COALESCE(updated_at, created_at)
            WHERE tally_synced_at IS NULL
              AND (tally_guid IS NOT NULL
                   OR id IN (SELECT DISTINCT company_id FROM tally_ledgers))
        `);
    }
    // Categories were re-pushed every cycle by design (nothing to stamp). Any
    // category that came FROM a Tally stock group already exists there.
    if (await knex.schema.hasTable('categories')) {
        await knex.raw(`
            UPDATE categories SET tally_synced_at = COALESCE(updated_at, created_at)
            WHERE tally_synced_at IS NULL AND tally_guid IS NOT NULL
        `);
    }

    // Same story on the already-equipped tables: migration 001 cleared their
    // placeholder guids, so anything that WAS stamped must keep counting as
    // synced — otherwise /pending would re-push the entire customer/product book
    // back into Tally as duplicate Create requests.
    //
    // The discriminator must be EXACT: `is_tally_ledger` defaults to true even on
    // a cloud-created record that has genuinely never been pushed, so keying off
    // it would silently swallow real pending pushes. record_history is exact —
    // the importer writes one row per record it created, with source='tally'.
    const MODULE_FOR = {
        customers: 'customers', suppliers: 'suppliers',
        products: 'products', locations: 'locations', categories: 'categories',
    };
    for (const [table, moduleName] of Object.entries(MODULE_FOR)) {
        if (!(await knex.schema.hasTable(table))) continue;
        await knex.raw(`
            UPDATE ${table} t SET tally_synced_at = COALESCE(t.updated_at, t.created_at)
            WHERE t.tally_synced_at IS NULL
              AND EXISTS (
                  SELECT 1 FROM record_history h
                  WHERE h.source = 'tally' AND h.module = ?
                    AND h.record_id = t.id AND h.company_id = t.company_id
              )
        `, [moduleName]);
    }
};

exports.down = async function down(knex) {
    for (const table of ['companies', 'categories']) {
        if (!(await knex.schema.hasTable(table))) continue;
        await knex.schema.alterTable(table, (t) => {
            t.dropColumn('tally_synced_at');
            t.dropColumn('tally_dirty');
        }).catch(() => {});
    }
};
