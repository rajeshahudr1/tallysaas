'use strict';

/**
 * 20260101000007_create_password_resets.js
 *
 * password_resets — short-lived "forgot password" tokens.
 *
 * Keyed by email (not a user FK) so the table also covers requests for
 * addresses that may not (yet) resolve to a user, and so a hard user delete
 * never orphans constraints. `token` is the opaque reset secret and
 * `expires_at` bounds its validity. Rows are reference/ephemeral data — no
 * company_id, no soft-delete; only a created_at stamp is kept.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('password_resets', (t) => {
        t.bigIncrements('id').primary();

        t.string('email', 191).notNullable();
        t.string('token', 191).notNullable();
        t.timestamp('expires_at', { useTz: true }).notNullable();

        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

        t.index('email', 'idx_password_resets_email');
        t.index('token', 'idx_password_resets_token');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('password_resets');
};
