'use strict';

/**
 * 20260101000032_add_last_open_companies_to_licenses.js
 *
 * The sync agent now reports, on every heartbeat, the list of companies
 * currently OPEN/loaded in Tally on the customer's PC. We store the most recent
 * list on the license so the cloud (and the web Sync page) can show
 * "Currently open in Tally: X, Y".
 *
 *   licenses.last_open_companies — TEXT, nullable, a JSON-encoded array of the
 *     open company names (e.g. '["Acme Pvt Ltd","Beta Traders"]'). NULL until
 *     the first heartbeat that carries the list. Additive/nullable, so existing
 *     data and the working heartbeat path are untouched (last_seen_at already
 *     exists on the licenses table).
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        // JSON-encoded array of company names currently open in Tally (nullable
        // until the first heartbeat that reports them).
        t.text('last_open_companies').nullable();
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('last_open_companies');
    });
};
