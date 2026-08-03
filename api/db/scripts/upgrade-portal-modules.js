'use strict';

/**
 * api/db/scripts/upgrade-portal-modules.js
 *
 * One-off idempotent upgrade: add the 'customer-users' and 'website-users' RBAC
 * modules (5 actions each) to the MASTER + every tenant permissions catalogue,
 * and grant the new permissions to the SYSTEM roles (super-admin /
 * company-admin) in each tenant so admins see the menus immediately.
 *
 * License entitlements: a license with NO explicit license_permissions rows is
 * entitled to ALL modules (new ones included, automatically). A license WITH an
 * explicit whitelist stays as-is — the super-admin ticks the new modules on the
 * License → Modules screen, exactly like any other module.
 *
 * Run:  node db/scripts/upgrade-portal-modules.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const knexLib = require('knex');

const MASTER_DB = String(process.env.MASTER_DB_DATABASE || 'tallysaas_master');
const NEW_MODULES = ['customer-users', 'website-users'];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

function baseConn(database) {
    return {
        host:     process.env.DB_HOST || '127.0.0.1',
        port:     parseInt(process.env.DB_PORT, 10) || 5432,
        user:     process.env.DB_USERNAME || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
        database,
    };
}

async function seedPerms(knex) {
    const ids = [];
    for (const mod of NEW_MODULES) {
        for (const action of ACTIONS) {
            const slug = `${mod}.${action}`;
            let row = await knex('permissions').where('slug', slug).first('id');
            if (!row) [row] = await knex('permissions').insert({ module: mod, action, slug }).returning('id');
            ids.push(row.id);
        }
    }
    return ids;
}

(async () => {
    // 1. MASTER catalogue.
    const master = knexLib({ client: 'pg', connection: baseConn(MASTER_DB), pool: { min: 1, max: 2 } });
    let licenses = [];
    try {
        await seedPerms(master);
        console.log('✓ master permissions seeded');
        licenses = await master('licenses').select('id');
    } finally {
        await master.destroy();
    }

    // 2. Every tenant: catalogue + system-role grants.
    for (const lic of licenses) {
        const dbName = `tally_lic_${lic.id}`;
        const tenant = knexLib({ client: 'pg', connection: baseConn(dbName), pool: { min: 1, max: 2 } });
        try {
            const permIds = await seedPerms(tenant);
            const sysRoles = await tenant('roles')
                .whereNull('company_id').where('is_system', true)
                .whereIn('slug', ['super-admin', 'company-admin'])
                .select('id');
            for (const r of sysRoles) {
                for (const pid of permIds) {
                    await tenant('role_permissions')
                        .insert({ role_id: r.id, permission_id: pid })
                        .onConflict(['role_id', 'permission_id']).ignore();
                }
            }
            console.log(`✓ ${dbName} upgraded (${permIds.length} perms, ${sysRoles.length} system roles granted)`);
        } catch (err) {
            console.error(`✗ ${dbName}: ${err.message}`);
        } finally {
            await tenant.destroy();
        }
    }
    console.log('Done.');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
