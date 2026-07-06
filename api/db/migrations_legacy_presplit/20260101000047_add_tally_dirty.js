'use strict';

/**
 * 20260101000047_add_tally_dirty.js
 *
 * Bidirectional push: a `tally_dirty` flag marks a master that was EDITED in the
 * cloud AFTER it was already pushed to Tally, so the push queue re-sends it (as
 * an ALTER, not a CREATE) and clears the flag on success.
 *
 *   • Set true  ← a tenant UPDATE in the cloud (Company/Customer/Supplier/Location).
 *   • NOT set   ← the Tally→cloud PULL (that's an inbound change, must not bounce
 *                 back to Tally — prevents a sync loop).
 *   • Cleared   ← the agent reports a successful push (AgentController.result).
 *
 * Default false; existing rows are not considered dirty.
 */

const TABLES = ['companies', 'customers', 'suppliers', 'locations'];

exports.up = async function up(knex) {
    for (const t of TABLES) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await knex.schema.hasColumn(t, 'tally_dirty'))) {
            // eslint-disable-next-line no-await-in-loop
            await knex.schema.alterTable(t, (tbl) => {
                tbl.boolean('tally_dirty').notNullable().defaultTo(false);
            });
        }
    }
};

exports.down = async function down(knex) {
    for (const t of TABLES) {
        // eslint-disable-next-line no-await-in-loop
        if (await knex.schema.hasColumn(t, 'tally_dirty')) {
            // eslint-disable-next-line no-await-in-loop
            await knex.schema.alterTable(t, (tbl) => tbl.dropColumn('tally_dirty'));
        }
    }
};
