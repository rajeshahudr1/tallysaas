'use strict';

/**
 * 01_master.js — seed the MASTER control-plane database.
 *
 * Runs after the master migration (knex seed:run). Seeds ONLY what master needs:
 *   • the 115-permission catalogue (permissions table — the shared RBAC list),
 *   • the platform super-admin login (admin@tallysaas.test / Admin@123).
 *
 * NO roles / role_permissions / company here — those are TENANT concerns (master
 * has no roles table). Reuses db/provision.js's seedPermissions so knex-seed and
 * provision.js seed the SAME catalogue. Idempotent (safe to re-run).
 *
 * The 2 old single-DB seeds (which also seeded roles + a demo company into one
 * db) are archived under db/seeds_legacy_presplit/.
 */

const { seedPermissions } = require('../provision');
const passwords = require('../../Helpers/passwords');

const SUPER_ADMIN_EMAIL = 'admin@tallysaas.test';
const SUPER_ADMIN_PASSWORD = 'Admin@123';

exports.seed = async function seed(knex) {
    // 1) Permission catalogue (23 modules × 5 actions = 115). Idempotent.
    const perms = await seedPermissions(knex);

    // 2) Platform super-admin — no license, no tenant → role_id NULL; role_slug
    //    'super-admin' drives the auth bypass. Created once.
    const existing = await knex('users').whereRaw('lower(email) = ?', [SUPER_ADMIN_EMAIL]).first('id');
    if (!existing) {
        const hash = await passwords.hash(SUPER_ADMIN_PASSWORD);
        await knex('users').insert({
            name: 'Super Admin', email: SUPER_ADMIN_EMAIL, password_hash: hash,
            role_id: null, role_slug: 'super-admin', company_id: null, license_id: null,
            status: 'Active', approval_status: 'approved',
        });
        console.log(`✓ super-admin '${SUPER_ADMIN_EMAIL}' created (password ${SUPER_ADMIN_PASSWORD})`);
    } else {
        console.log(`✓ super-admin '${SUPER_ADMIN_EMAIL}' already exists`);
    }
    console.log(`✓ master permissions catalogue: ${Object.keys(perms).length}`);
};
