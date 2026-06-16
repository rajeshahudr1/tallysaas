'use strict';

/**
 * 20260101000029_add_user_approval.js
 *
 * Per-user APPROVAL workflow (user-wise subscription billing).
 *
 * A license-admin can create company users, but those users CANNOT log in until
 * the platform Super Admin approves them — because each active user is a paid
 * seat. This adds an explicit approval state ORTHOGONAL to `status`:
 *   • status          — enabled / disabled by an admin (Active | Inactive | Blocked)
 *   • approval_status — the platform's seat approval (pending | approved | rejected)
 *
 * Login requires approval_status = 'approved' (Super Admin bypasses). On approval
 * the Super Admin also creates the subscription seat, so an approved user has
 * both the flag AND an active subscription.
 *
 * Backfill: every EXISTING user is set to 'approved' so current logins keep
 * working; only users created AFTER this migration default to 'pending'.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('users', (t) => {
        t.text('approval_status').notNullable().defaultTo('pending'); // pending | approved | rejected
        t.timestamp('approved_at', { useTz: true }).nullable();
        t.bigInteger('approved_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.index(['approval_status'], 'idx_users_approval_status');
    });

    // Grandfather all existing (non-deleted) users as approved (they already log
    // in today). approved_by stays NULL — a system backfill has no approver.
    await knex('users').whereNull('deleted_at')
        .update({ approval_status: 'approved', approved_at: knex.fn.now() });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('users', (t) => {
        t.dropIndex(['approval_status'], 'idx_users_approval_status');
        t.dropColumn('approved_by');
        t.dropColumn('approved_at');
        t.dropColumn('approval_status');
    });
};
