'use strict';

/**
 * MASTER migration — per-licence database credentials.
 *
 * Each licence's tenant db is reached through its OWN PostgreSQL LOGIN role
 * (see Helpers/tenantRoles.js) instead of the shared cluster superuser. The
 * role name and its AES-256-GCM-encrypted password live here, on the licence
 * row, so config/tenantCredentials.js can load the whole directory at boot.
 *
 * NULL in both columns = "not migrated yet" — that licence still falls back to
 * the admin credentials until db/scripts/upgrade-tenant-roles.js has run for it
 * (or, when TENANT_DB_STRICT_ROLES=true, is refused outright).
 *
 * The password is NEVER stored in clear; decryption needs LICENSE_KEY_SECRET,
 * which lives in the .env and not in the database.
 */

exports.up = async function up(knex) {
    const hasRole = await knex.schema.hasColumn('licenses', 'db_role');
    const hasPw   = await knex.schema.hasColumn('licenses', 'db_role_password_enc');
    if (hasRole && hasPw) return;

    await knex.schema.alterTable('licenses', (t) => {
        if (!hasRole) t.string('db_role', 64).nullable().comment('per-licence PG LOGIN role, e.g. tally_lic_7_app');
        if (!hasPw)   t.text('db_role_password_enc').nullable().comment('AES-256-GCM blob (Helpers/keyCrypto)');
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('db_role');
        t.dropColumn('db_role_password_enc');
    });
};
