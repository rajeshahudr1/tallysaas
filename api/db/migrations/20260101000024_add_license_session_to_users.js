'use strict';

/**
 * 20260101000024_add_license_session_to_users.js
 *
 * Users are common to a LICENSE (can access every company under it).
 *   • license_id          — which license this user belongs to
 *   • current_company_id   — last-selected company (the one they're acting on)
 *   • active_session_jti   — single active session. A second login is blocked
 *                            while this session is live (see AuthController).
 *   • session_last_seen / session_expires_at — liveness window for the session.
 *
 * Existing `users.company_id` is kept (primary/current company; backward compat).
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('users', (t) => {
        t.bigInteger('license_id').nullable()
            .references('id').inTable('licenses').onDelete('SET NULL');
        t.bigInteger('current_company_id').nullable();
        t.string('active_session_jti', 64).nullable();
        t.timestamp('session_last_seen').nullable();
        t.timestamp('session_expires_at').nullable();
        t.index(['license_id'], 'idx_users_license');
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('users', (t) => {
        t.dropIndex(['license_id'], 'idx_users_license');
        t.dropColumn('license_id');
        t.dropColumn('current_company_id');
        t.dropColumn('active_session_jti');
        t.dropColumn('session_last_seen');
        t.dropColumn('session_expires_at');
    });
};
