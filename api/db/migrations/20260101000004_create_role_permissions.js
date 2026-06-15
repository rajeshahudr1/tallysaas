'use strict';

/**
 * 20260101000004_create_role_permissions.js
 *
 * role_permissions — the join grid wiring roles to permissions.
 *
 * One row grants one permission to one role. The unique(role_id, permission_id)
 * constraint keeps the grid idempotent (the seed uses ON CONFLICT DO NOTHING).
 * Deleting a role or permission cascades the grant rows away.
 *
 * The seed fills this from the RBAC matrix mirrored out of
 * web/data/mock.js `_buildRolePerms` (see seeds/01_roles_permissions.js).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('role_permissions', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('role_id')
            .notNullable()
            .references('id').inTable('roles')
            .onDelete('CASCADE');

        t.bigInteger('permission_id')
            .notNullable()
            .references('id').inTable('permissions')
            .onDelete('CASCADE');

        t.timestamps(true, true);

        t.unique(['role_id', 'permission_id'], 'uq_role_permissions_role_perm');
        t.index('role_id',       'idx_role_permissions_role_id');
        t.index('permission_id', 'idx_role_permissions_permission_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('role_permissions');
};
