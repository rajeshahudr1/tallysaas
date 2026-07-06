'use strict';

/**
 * 20260101000033_create_agent_commands.js
 *
 * agent_commands — a command channel from the cloud to the local Python sync
 * agent. The web/app user queues a command (e.g. "open this company in Tally")
 * against their license; the agent polls /agent/commands, picks up the pending
 * rows for its license, runs them on the customer PC, and reports the result
 * back via /agent/commands/:id/result.
 *
 *   license_id  — owner license (the agent authenticates as a license); a command
 *                 is only ever visible to / picked up by its own license's agent.
 *   company_id  — the target cloud company (nullable; e.g. open_company targets one).
 *   type        — command kind, currently 'open_company'.
 *   payload     — JSON string of command args, e.g. {company_name, company_number}.
 *   status      — pending → running → done | failed. The agent flips pending→running
 *                 transactionally on pickup, then →done/failed when finished.
 *   result/error— free-text outcome (method used / failure hint).
 *   created_by  — the user who queued it (nullable).
 *   picked_at   — when the agent claimed the row (status→running).
 *
 * Indexed on (license_id, status) — the agent's hot path selects this license's
 * pending rows.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('agent_commands', (t) => {
        t.increments('id').primary();

        t.integer('license_id')
            .notNullable()
            .references('id').inTable('licenses')
            .onDelete('CASCADE');

        t.integer('company_id')
            .nullable()
            .references('id').inTable('companies')
            .onDelete('SET NULL');

        t.string('type').notNullable();                          // 'open_company'
        t.text('payload').nullable();                            // JSON: {company_name, company_number}

        t.string('status').notNullable().defaultTo('pending');   // pending|running|done|failed
        t.text('result').nullable();
        t.text('error').nullable();

        t.integer('created_by')
            .nullable()
            .references('id').inTable('users')
            .onDelete('SET NULL');

        t.timestamp('picked_at').nullable();

        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());

        t.index(['license_id', 'status']);
    });
};

exports.down = function down(knex) {
    return knex.schema.dropTableIfExists('agent_commands');
};
