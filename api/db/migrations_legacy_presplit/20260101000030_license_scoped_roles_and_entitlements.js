'use strict';

/**
 * 20260101000030_license_scoped_roles_and_entitlements.js
 *
 * Phase C foundation — two changes that let a license-admin own CUSTOM roles
 * built only from the modules the platform Super Admin granted to their license.
 *
 * 1) roles.license_id — makes a role LICENSE-scoped (custom roles a license-admin
 *    creates) vs the global SYSTEM roles (license_id NULL, is_system true). A
 *    custom role's slug is unique within its license (license_id is NOT NULL for
 *    those, so the unique index actually enforces it; system roles keep
 *    license_id NULL and are de-duped by the seed, as before).
 *
 * 2) license_permissions — per-license module/permission ENTITLEMENTS. The set of
 *    permissions a license's roles may be granted. An EMPTY set for a license is
 *    treated as "ALL permissions" by Helpers/entitlements (so existing licenses
 *    keep working); the Super Admin restricts a license by inserting an explicit
 *    subset. New licenses are granted ALL on creation (LicenseController).
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('roles', (t) => {
        t.bigInteger('license_id').nullable()
            .references('id').inTable('licenses').onDelete('CASCADE');
        // Custom roles (license_id NOT NULL) get a real per-license unique slug;
        // system roles (license_id NULL) are unaffected (NULLs are distinct).
        t.unique(['license_id', 'slug'], 'uq_roles_license_slug');
        t.index(['license_id'], 'idx_roles_license_id');
    });

    await knex.schema.createTable('license_permissions', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable()
            .references('id').inTable('licenses').onDelete('CASCADE');
        t.bigInteger('permission_id').notNullable()
            .references('id').inTable('permissions').onDelete('CASCADE');
        t.timestamps(true, true);

        t.unique(['license_id', 'permission_id'], 'uq_license_permissions');
        t.index('license_id', 'idx_license_permissions_license');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('license_permissions');
    await knex.schema.alterTable('roles', (t) => {
        t.dropUnique(['license_id', 'slug'], 'uq_roles_license_slug');
        t.dropIndex(['license_id'], 'idx_roles_license_id');
        t.dropColumn('license_id');
    });
};
