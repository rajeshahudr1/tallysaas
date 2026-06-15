'use strict';

/**
 * 20260101000021_create_licenses.js
 *
 * A `license` = ONE Tally license / customer install. It owns many
 * companies and many (common) users. The secret license key is stored
 * ONLY as a sha256 hash; `key_prefix` is the non-secret lookup/display
 * handle. On first agent activation the license binds to one machine
 * fingerprint (`machine_id`); a different machine is rejected. All
 * entitlement is enforced cloud-side, so `status` here is authoritative
 * (an admin can suspend instantly).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('licenses', (t) => {
        t.bigIncrements('id').primary();
        t.string('license_key_hash', 128).notNullable();          // sha256 hex of the key
        t.string('key_prefix', 40).notNullable().unique();        // e.g. "TCS-AB12C" (non-secret)
        t.string('tally_serial', 60).nullable();
        t.string('holder_name', 191).notNullable();
        t.string('plan', 40).notNullable().defaultTo('standard');
        t.integer('max_companies').notNullable().defaultTo(5);
        t.integer('max_users').notNullable().defaultTo(10);
        t.date('valid_until').nullable();
        t.string('status', 20).notNullable().defaultTo('active');  // active | suspended | expired
        t.string('machine_id', 191).nullable();                    // bound fingerprint
        t.timestamp('machine_bound_at').nullable();
        t.timestamp('last_seen_at').nullable();                    // agent heartbeat
        t.string('agent_version', 40).nullable();
        t.bigInteger('created_by').nullable();
        t.timestamps(true, true);
        t.timestamp('deleted_at').nullable();

        t.index(['status'], 'idx_licenses_status');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('licenses');
};
