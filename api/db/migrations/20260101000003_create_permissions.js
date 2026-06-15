'use strict';

/**
 * 20260101000003_create_permissions.js
 *
 * permissions — the catalogue of (module, action) capabilities.
 *
 * Each row pairs a module (e.g. 'customers') with an action
 * (view | create | edit | delete | export). `slug` = `<module>.<action>`
 * and is globally unique — it is the value the rbac middleware looks up when
 * deciding whether a role may perform an action.
 *
 * The seed populates the full grid: 17 modules × 5 actions. Permissions are
 * global reference data (not company-scoped, no soft-delete).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('permissions', (t) => {
        t.bigIncrements('id').primary();

        t.string('module', 60).notNullable();                   // e.g. 'customers'
        t.string('action', 20).notNullable();                   // view|create|edit|delete|export
        t.string('slug', 100).notNullable().unique();           // '<module>.<action>'

        t.timestamps(true, true);

        t.index('module', 'idx_permissions_module');
        t.unique(['module', 'action'], 'uq_permissions_module_action');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('permissions');
};
