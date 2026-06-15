'use strict';

/**
 * 20260101000006_create_users.js
 *
 * users — login accounts.
 *
 * A user belongs to a company (company_id) EXCEPT the platform Super Admin,
 * whose company_id may be NULL (cross-tenant). `role_id` ties the user to an
 * RBAC role; `location_id` optionally pins a user to one branch.
 *
 * `email` is stored lower-cased and uniquely indexed (login lookup). The
 * password is held only as `password_hash` (argon2id, bcrypt-verifiable).
 * `last_login_at` is bumped on each successful login. Tenant-scoped, soft-delete.
 *
 * Ordered after locations (location_id FK) and roles (role_id FK).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('users', (t) => {
        t.bigIncrements('id').primary();

        // nullable for the platform Super Admin (no single owning company)
        t.bigInteger('company_id')
            .nullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('role_id')
            .notNullable()
            .references('id').inTable('roles')
            .onDelete('RESTRICT');

        t.bigInteger('location_id')
            .nullable()
            .references('id').inTable('locations')
            .onDelete('SET NULL');

        t.string('name', 150).notNullable();
        t.string('email', 191).notNullable().unique();          // stored lower-cased
        t.string('mobile', 30);
        t.string('password_hash', 255).notNullable();
        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive | Blocked
        t.timestamp('last_login_at', { useTz: true });

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('email',      'idx_users_email');
        t.index('company_id', 'idx_users_company_id');
        t.index('role_id',    'idx_users_role_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('users');
};
