'use strict';

/**
 * Tenant migration 005 — the two masters Tally exposes that migration 004 still
 * missed: GST TAX UNITS and TDS RATES.
 *
 *   • tally_tax_units — the GST registration a return is filed under. A company
 *     with branches in three states has three, and every GST figure belongs to
 *     exactly one of them. Without this table the GST screens aggregate across
 *     registrations, which is the wrong number for any multi-state company and
 *     right only by accident for a single-state one.
 *   • tally_tds_rates — tally_tds_categories (migration 004) holds the SECTION
 *     ("194C — Contractors"); the percentage actually deducted lives here and
 *     varies by deductee type, threshold and effective date. Without it the
 *     cloud can say a payment fell under 194C but not what should have been
 *     deducted, so no TDS figure can be checked against Tally's.
 *
 * Both follow migration 004's identity contract unchanged — (company_id,
 * tally_guid) unique, tally_master_id, tally_alter_id, deleted_at, jsonb extra
 * — so the reconcile pass delete-syncs them with no extra code, and the read
 * paths exclude soft-deleted rows via the same whereNull('deleted_at').
 *
 * Guarded with hasTable so a fresh tenant that already declares these in
 * tenant-schema.sql runs this as a no-op rather than failing.
 */

/** Identical to migration 004's masterTable — restated rather than imported so
 *  editing that file's helper can never silently reshape a table created here. */
async function masterTable(knex, name, extend) {
    if (await knex.schema.hasTable(name)) return;
    await knex.schema.createTable(name, (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable();
        t.string('name', 255).notNullable();
        t.string('tally_guid', 120).nullable();
        t.bigInteger('tally_master_id').nullable();
        t.bigInteger('tally_alter_id').defaultTo(0);
        extend(t);
        // Overflow bucket: an unmodelled Tally tag is STORED, not lost, so
        // widening the mapping later never needs a re-pull.
        t.jsonb('extra').notNullable().defaultTo('{}');
        t.timestamp('deleted_at', { useTz: true }).nullable();
        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

        t.index(['company_id'], `${name}_company_idx`);
        t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
    });
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_name_uq
                    ON ${name} (company_id, name)`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_tally_guid_uq
                    ON ${name} (company_id, tally_guid) WHERE tally_guid IS NOT NULL`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_tally_master_id_uq
                    ON ${name} (company_id, tally_master_id) WHERE tally_master_id IS NOT NULL`);
    // Delete-sync reads (company_id, deleted_at) on every list — same index the
    // migration-001 tables carry.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${name}_deleted_at_idx
                    ON ${name} (company_id, deleted_at)`);
}

const TABLES = [
    ['tally_tax_units', (t) => {
        t.string('gstin', 20).nullable();
        t.string('state', 120).nullable();
        t.string('registration_type', 60).nullable();   // Regular / Composition / …
        t.date('applicable_from').nullable();
        t.boolean('is_default').defaultTo(false);
    }],
    ['tally_tds_rates', (t) => {
        t.string('category', 255).nullable();           // -> tally_tds_categories.name
        t.string('deductee_type', 120).nullable();      // Company / Individual / HUF / …
        t.date('applicable_from').nullable();
        t.decimal('rate', 8, 3).defaultTo(0);
        t.decimal('surcharge', 8, 3).defaultTo(0);
        t.decimal('cess', 8, 3).defaultTo(0);
        t.string('zero_rate_reason', 255).nullable();   // lower/nil-deduction certificate
        // Below this annual payment there is no liability — needed to decide
        // whether a rate applies at all, not just what it is.
        t.decimal('exemption_limit', 18, 2).defaultTo(0);
    }],
];

exports.up = async function up(knex) {
    for (const [name, extend] of TABLES) {
        await masterTable(knex, name, extend);
    }
    // A rate is always looked up BY category — the join every TDS screen makes.
    if (await knex.schema.hasTable('tally_tds_rates')) {
        await knex.raw(`CREATE INDEX IF NOT EXISTS tally_tds_rates_category_idx
                        ON tally_tds_rates (company_id, category)`).catch(() => {});
    }
};

exports.down = async function down(knex) {
    for (const [name] of [...TABLES].reverse()) {
        await knex.schema.dropTableIfExists(name);
    }
};
