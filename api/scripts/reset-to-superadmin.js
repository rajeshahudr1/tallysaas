'use strict';

/**
 * scripts/reset-to-superadmin.js
 *
 * DESTRUCTIVE dev reset: wipes ALL tenant + licensing data from the cloud
 * database and keeps ONLY the platform Super Admin login(s), the global system
 * roles, and the permission catalogue. Use to start the licensing/RBAC flow
 * from a clean slate (create a fresh license → company → users → sync).
 *
 * KEPT:    users where role = super-admin (FKs to company/license nulled),
 *          system roles (is_system = true), permissions.
 * DELETED: every license, company, custom role, non-super user, subscription,
 *          session, and all tenant data (customers/suppliers/products/…,
 *          invoices/payments/journals/…), plus license_permissions + sync logs.
 *
 * Does NOT touch Tally — this only clears the cloud Postgres database.
 *
 * Run:  node scripts/reset-to-superadmin.js          (asks nothing; just does it)
 */

const { db } = require('../config/db');

// Child → parent delete order (so FK constraints are satisfied). Tables that may
// not exist in every install are guarded by hasTable below.
const WIPE_TABLES = [
    'invoice_items',
    'invoices',
    'payments',
    'journals',
    'stock_adjustments',
    'sales_person_locations',
    'sync_logs',
    'subscriptions',
    'user_sessions',
    'password_resets',
    'license_permissions',
    'customers',
    'customer_groups',
    'suppliers',
    'products',
    'categories',
    'sales_persons',
    'locations',
];

async function count(table) {
    if (!(await db.schema.hasTable(table))) return null;
    const [{ c }] = await db(table).count({ c: '*' });
    return Number(c);
}

async function main() {
    console.log('— TallySaaS DB reset → Super Admin only —\n');

    const superAdmins = await db('users as u')
        .leftJoin('roles as r', 'r.id', 'u.role_id')
        .where('r.slug', 'super-admin')
        .whereNull('u.deleted_at')
        .select('u.id', 'u.email');
    if (!superAdmins.length) {
        throw new Error('Refusing to reset: no super-admin user found. Run the seeds first.');
    }
    const keepIds = superAdmins.map((s) => s.id);
    console.log('Keeping super-admin(s):', superAdmins.map((s) => `${s.email} (id ${s.id})`).join(', '));

    // Pre-counts (for the report).
    const before = {};
    for (const t of ['licenses', 'companies', 'users', 'roles', ...WIPE_TABLES]) {
        before[t] = await count(t);
    }

    await db.transaction(async (trx) => {
        // 1) Break the super-admin's FKs to company/license BEFORE deleting those
        //    (users.company_id / license_id would otherwise CASCADE-delete them).
        await trx('users').whereIn('id', keepIds).update({
            company_id: null, license_id: null, current_company_id: null,
            status: 'Active', approval_status: 'approved', approved_at: trx.fn.now(),
            updated_at: trx.fn.now(),
        });

        // 2) Empty every tenant/data + licensing-link table.
        for (const t of WIPE_TABLES) {
            if (await trx.schema.hasTable(t)) await trx(t).del();
        }

        // 3) Delete every NON super-admin user.
        await trx('users').whereNotIn('id', keepIds).del();

        // 4) Delete custom (non-system) roles + their permission rows.
        const customRoleIds = (await trx('roles').where('is_system', false).select('id')).map((r) => r.id);
        if (customRoleIds.length) {
            await trx('role_permissions').whereIn('role_id', customRoleIds).del();
            await trx('roles').whereIn('id', customRoleIds).del();
        }

        // 5) Delete companies, then licenses (now unreferenced).
        await trx('companies').del();
        await trx('licenses').del();
    });

    // Post-counts.
    const after = {};
    for (const t of ['licenses', 'companies', 'users', 'roles', ...WIPE_TABLES]) {
        after[t] = await count(t);
    }

    console.log('\nTable                         before →  after');
    console.log('------------------------------------------------');
    for (const t of ['licenses', 'companies', 'users', 'roles', ...WIPE_TABLES]) {
        if (before[t] === null) continue;
        console.log(`${t.padEnd(28)} ${String(before[t]).padStart(5)} → ${String(after[t]).padStart(6)}`);
    }
    console.log('\n✓ Reset complete. Only the super-admin, system roles and permissions remain.');
    console.log('  Log in as the super-admin and create a fresh License → Company → Users.');
}

main()
    .then(() => db.destroy())
    .catch(async (err) => {
        console.error('\n✗ Reset FAILED (no changes committed):', err.message);
        await db.destroy();
        process.exit(1);
    });
