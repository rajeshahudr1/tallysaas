'use strict';

/**
 * db/seeds/02_super_admin.js
 *
 * Seeds ONLY the platform Super Admin login — no demo company, no sample data.
 *
 *   user: Super Admin <admin@tallysaas.test> / password 'Admin@123'
 *         role = super-admin, company_id = NULL (platform admin, not tied to any
 *         company). The Super Admin then issues licences; each company that logs
 *         in starts EMPTY and creates its own roles (only super-admin +
 *         company-admin are built-in — see 01_roles_permissions.js).
 *
 * The password is hashed with argon2id via Helpers/passwords.hash() so the
 * stored value matches what the login flow verifies against. Idempotent: the
 * user is matched/upserted by its unique email.
 *
 * Depends on 01_roles_permissions.js having created the 'super-admin' role.
 */

const passwords = require('../../Helpers/passwords');

const ADMIN = {
    name:   'Super Admin',
    email:  'admin@tallysaas.test',
    status: 'Active',
};
const ADMIN_PASSWORD = 'Admin@123';

exports.seed = async function (knex) {

    // super-admin role id (seeded in 01_roles_permissions.js).
    const superAdminRole = await knex('roles')
        .whereNull('company_id')
        .andWhere('slug', 'super-admin')
        .first();
    if (!superAdminRole) {
        throw new Error("Seed 02 requires the 'super-admin' role from seed 01 — run seeds in order.");
    }

    // USER — hash the password (argon2id) then upsert by email. NO company_id:
    // the Super Admin is a platform-level account, not a tenant member.
    const passwordHash = await passwords.hash(ADMIN_PASSWORD);
    const email = ADMIN.email.toLowerCase();

    const existingUser = await knex('users').where('email', email).first();
    if (existingUser) {
        await knex('users')
            .where('id', existingUser.id)
            .update({
                name:            ADMIN.name,
                role_id:         superAdminRole.id,
                company_id:      null,
                password_hash:   passwordHash,
                status:          ADMIN.status,
                approval_status: 'approved',
                approved_at:     knex.fn.now(),
                deleted_at:      null,
                updated_at:      knex.fn.now(),
            });
        console.log(`✓ super-admin user '${email}' updated (id=${existingUser.id}, no company)`);
    } else {
        const [u] = await knex('users')
            .insert({
                name:            ADMIN.name,
                email,
                role_id:         superAdminRole.id,
                company_id:      null,
                password_hash:   passwordHash,
                status:          ADMIN.status,
                approval_status: 'approved',
                approved_at:     knex.fn.now(),
            })
            .returning('id');
        console.log(`✓ super-admin user '${email}' created (id=${u.id}, no company)`);
    }

    console.log('  login → email: admin@tallysaas.test   password: Admin@123  (Super Admin only — no demo company)');
};
