'use strict';

/**
 * db/seeds/02_super_admin.js
 *
 * Seeds the demo tenant company and the platform Super Admin login.
 *
 *   company: ABC Pvt. Ltd. (slug 'abc', status Active, FY 2024-2025)
 *   user:    Rajesh Admin <admin@tallysaas.test>  /  password 'Admin@123'
 *            role = super-admin, company_id = ABC.
 *
 * The password is hashed with argon2id via Helpers/passwords.hash() so the
 * stored value matches exactly what the login flow verifies against.
 *
 * Idempotent: the company is matched/upserted by its unique slug and the user
 * by its unique email; re-running refreshes the rows in place rather than
 * inserting duplicates.
 *
 * Depends on 01_roles_permissions.js having created the 'super-admin' role.
 */

const passwords = require('../../Helpers/passwords');

const COMPANY = {
    name:            'ABC Pvt. Ltd.',
    slug:            'abc',
    email:           'info@abcpvt.com',
    status:          'Active',
    financial_year:  '2024-2025',
};

const ADMIN = {
    name:   'Rajesh Admin',
    email:  'admin@tallysaas.test',
    status: 'Active',
};
const ADMIN_PASSWORD = 'Admin@123';

exports.seed = async function (knex) {

    // 1) COMPANY — upsert by slug, capture id.
    let company = await knex('companies').where('slug', COMPANY.slug).first();
    if (company) {
        await knex('companies')
            .where('id', company.id)
            .update({
                name:           COMPANY.name,
                email:          COMPANY.email,
                status:         COMPANY.status,
                financial_year: COMPANY.financial_year,
                updated_at:     knex.fn.now(),
            });
    } else {
        const [inserted] = await knex('companies').insert(COMPANY).returning('id');
        company = inserted;
    }
    const companyId = company.id;
    console.log(`✓ company '${COMPANY.slug}' (ABC Pvt. Ltd.) id=${companyId}`);

    // 2) super-admin role id (seeded in 01_roles_permissions.js).
    const superAdminRole = await knex('roles')
        .whereNull('company_id')
        .andWhere('slug', 'super-admin')
        .first();
    if (!superAdminRole) {
        throw new Error("Seed 02 requires the 'super-admin' role from seed 01 — run seeds in order.");
    }

    // 3) USER — hash the password (argon2id) then upsert by email.
    const passwordHash = await passwords.hash(ADMIN_PASSWORD);
    const email = ADMIN.email.toLowerCase();

    const existingUser = await knex('users').where('email', email).first();
    if (existingUser) {
        await knex('users')
            .where('id', existingUser.id)
            .update({
                name:            ADMIN.name,
                role_id:         superAdminRole.id,
                company_id:      companyId,
                password_hash:   passwordHash,
                status:          ADMIN.status,
                approval_status: 'approved',
                approved_at:     knex.fn.now(),
                deleted_at:      null,
                updated_at:      knex.fn.now(),
            });
        console.log(`✓ super-admin user '${email}' updated (id=${existingUser.id})`);
    } else {
        const [u] = await knex('users')
            .insert({
                name:            ADMIN.name,
                email,
                role_id:         superAdminRole.id,
                company_id:      companyId,
                password_hash:   passwordHash,
                status:          ADMIN.status,
                approval_status: 'approved',
                approved_at:     knex.fn.now(),
            })
            .returning('id');
        console.log(`✓ super-admin user '${email}' created (id=${u.id})`);
    }

    console.log('  login → email: admin@tallysaas.test   password: Admin@123');
};
