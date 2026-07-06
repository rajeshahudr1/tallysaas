'use strict';

/**
 * 20260101000022_create_subscriptions.js
 *
 * Per-USER subscription for cloud web/app access. Login is rejected when
 * a user has no active, in-date subscription (Super Admin bypasses).
 * Kept as a table (not columns on users) so history / renewals are auditable.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('subscriptions', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('user_id').notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        t.string('plan', 40).notNullable().defaultTo('standard');
        t.date('valid_from').notNullable();
        t.date('valid_until').notNullable();
        t.string('status', 20).notNullable().defaultTo('active');   // active | expired | cancelled
        t.timestamps(true, true);

        t.index(['user_id', 'status'], 'idx_subscriptions_user_status');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('subscriptions');
};
