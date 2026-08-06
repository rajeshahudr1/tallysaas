'use strict';

/**
 * Master migration — per-device agents + the OTP challenges that create them.
 *
 * Replaces licence-key activation. Two problems it fixes:
 *
 * 1) ONE MACHINE PER LICENCE. `licenses.machine_id` is singular, so a business
 *    running Tally on two PCs could not run two agents: the second activation
 *    overwrote the first, and the first agent then failed the machine check on
 *    every request with nothing explaining why. `agents` is one row per
 *    machine, so a licence can carry several — and a single lost machine can be
 *    revoked without touching the others.
 *
 * 2) NO PER-DEVICE REVOKE. Previously the only lever was rotating the licence
 *    key, which killed every install at once.
 *
 * `licenses.machine_id` / `machine_bound_at` are deliberately LEFT IN PLACE and
 * made nullable. New code neither reads nor writes them. Dropping a column is
 * expensive to reverse, so that happens in a later migration once `agents` has
 * proven itself in the field.
 */

exports.up = async function up(knex) {
    // ── agents: one row per activated machine ────────────────────
    if (!(await knex.schema.hasTable('agents'))) {
        await knex.schema.createTable('agents', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('license_id').notNullable()
                .references('id').inTable('licenses').onDelete('CASCADE');
            // Who activated it. Kept for audit even if that user is later
            // removed, hence SET NULL rather than CASCADE — deleting a staff
            // account must not silently delete a running agent.
            t.bigInteger('user_id').nullable()
                .references('id').inTable('users').onDelete('SET NULL');

            t.string('machine_id', 191).notNullable();
            // Human-readable ("DESKTOP-A1B2"). A device list showing hashes is
            // useless to the person deciding which one to revoke.
            t.string('machine_name', 191).nullable();

            t.string('agent_version', 40).nullable();
            t.timestamp('last_seen_at', { useTz: true }).nullable();

            t.string('status', 20).notNullable().defaultTo('active');   // active | revoked
            t.timestamp('activated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('revoked_at', { useTz: true }).nullable();
            t.bigInteger('revoked_by').nullable()
                .references('id').inTable('users').onDelete('SET NULL');

            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

            // Re-activating the SAME machine must update its row, not add a
            // second one — otherwise every re-login inflates the device list and
            // any seat limit counts one PC many times.
            t.unique(['license_id', 'machine_id'], { indexName: 'uq_agents_license_machine' });
            t.index(['license_id', 'status'], 'agents_license_status_idx');
        });
    }

    // ── agent_otp_challenges: the pending "we emailed you a code" state ──
    // Modelled on the existing `password_resets` table.
    if (!(await knex.schema.hasTable('agent_otp_challenges'))) {
        await knex.schema.createTable('agent_otp_challenges', (t) => {
            // The client echoes this back as `challenge_id`. A uuid rather than
            // a serial so it cannot be guessed or enumerated.
            t.uuid('id').primary();
            t.bigInteger('user_id').notNullable()
                .references('id').inTable('users').onDelete('CASCADE');

            // The challenge is bound to ONE machine. Without this a code
            // phished from one PC could be redeemed on the attacker's.
            t.string('machine_id', 191).notNullable();

            // The plaintext code is NEVER stored — same as password_resets.
            t.string('code_hash', 128).notNullable();

            t.timestamp('expires_at', { useTz: true }).notNullable();
            // Persisted, not held in memory: an in-process counter would reset
            // on every deploy and hand an attacker a fresh budget.
            t.integer('attempts').notNullable().defaultTo(0);
            t.integer('resends').notNullable().defaultTo(0);
            t.timestamp('last_sent_at', { useTz: true }).nullable();
            t.timestamp('consumed_at', { useTz: true }).nullable();
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

            // Expired-row sweeps and the per-user "latest wins" delete.
            t.index(['user_id'], 'agent_otp_user_idx');
            t.index(['expires_at'], 'agent_otp_expires_idx');
        });
    }

    // ── Loosen the old single-machine binding so it stops being enforced. ──
    if (await knex.schema.hasColumn('licenses', 'machine_id')) {
        await knex.raw('ALTER TABLE licenses ALTER COLUMN machine_id DROP NOT NULL')
            .catch(() => { /* already nullable */ });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('agent_otp_challenges');
    await knex.schema.dropTableIfExists('agents');
};
