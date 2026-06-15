'use strict';

/**
 * 20260101000002_create_roles.js
 *
 * roles — RBAC role definitions.
 *
 * A role may be a SYSTEM role (shared by every tenant) or a company-specific
 * custom role. System roles carry `company_id = NULL` and `is_system = true`;
 * the seed inserts the 5 system roles:
 *   super-admin, company-admin, sales-manager, sales-person, accountant.
 *
 * `company_id` is nullable here precisely so the system roles can be global.
 * It still references companies(id) so any future per-company role is scoped.
 * `slug` is the stable machine handle used by JWT payloads and rbac checks.
 *
 * No soft-delete on roles — they are reference data; removing a role is a hard
 * delete guarded by the application layer.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('roles', (t) => {
        t.bigIncrements('id').primary();

        // nullable → NULL means a global/system role shared by all companies
        t.bigInteger('company_id')
            .nullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.string('name', 100).notNullable();
        t.string('slug', 100).notNullable();                    // machine handle
        t.boolean('is_system').notNullable().defaultTo(false);

        t.timestamps(true, true);

        // A slug is unique within a company; system roles (company_id NULL)
        // are de-duped by the seed itself.
        t.unique(['company_id', 'slug'], 'uq_roles_company_slug');
        t.index('company_id', 'idx_roles_company_id');
        t.index('slug',       'idx_roles_slug');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('roles');
};
