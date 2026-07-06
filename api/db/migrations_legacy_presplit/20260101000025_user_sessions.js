'use strict';

/**
 * 20260101000025_user_sessions.js
 *
 * Multi-session support for WEB logins (the Tally agent uses a separate agent
 * token and is never counted here).
 *
 *   • user_sessions             — one row per live web session of a user. The
 *                                 authenticate middleware matches the JWT `jti`
 *                                 against a row here; a deleted row = signed out
 *                                 (this is how "last-login-wins" eviction kicks
 *                                 an older session).
 *   • companies.max_sessions_per_user
 *                               — Super-Admin-configurable cap: how many places
 *                                 ONE user of that company may be signed in at
 *                                 once (default 1). Super Admin itself is exempt.
 *
 * Supersedes the single `users.active_session_jti` model (that column stays for
 * a quick "current session" reference but is no longer the source of truth).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('user_sessions', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('user_id').notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        t.string('jti', 64).notNullable().unique();
        t.string('ip', 64).nullable();
        t.string('user_agent', 255).nullable();
        t.timestamp('last_seen_at').nullable();
        t.timestamp('expires_at').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['user_id'], 'idx_user_sessions_user');
    });

    await knex.schema.alterTable('companies', (t) => {
        t.integer('max_sessions_per_user').notNullable().defaultTo(1);
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('companies', (t) => {
        t.dropColumn('max_sessions_per_user');
    });
    await knex.schema.dropTableIfExists('user_sessions');
};
