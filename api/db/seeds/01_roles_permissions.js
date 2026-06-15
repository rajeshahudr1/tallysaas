'use strict';

/**
 * db/seeds/01_roles_permissions.js
 *
 * Seeds the RBAC backbone — system roles, the full permission catalogue, and
 * the role_permissions grid — for the single shared TallySaaS database.
 *
 *   roles:             5 system roles (company_id = NULL, is_system = true)
 *                        super-admin, company-admin, sales-manager,
 *                        sales-person, accountant
 *   permissions:       17 modules × 5 actions = 85 rows, slug = '<module>.<action>'
 *   role_permissions:  grants mirrored byte-for-byte from web/data/mock.js
 *                        `_buildRolePerms` (the web UI's RBAC matrix).
 *
 * RBAC matrix (from _buildRolePerms) — actions per module per role:
 *   ALL  = view, create, edit, delete, export
 *   RO   = view, export                       (read-only + export)
 *   CRU  = view, create, edit, export         (create/read/update + export, no delete)
 *   CR   = view, create                       (create + read only)
 *   NONE = (no grants)
 *
 *   Super Admin   → ALL on every module       (also bypassed in code, seeded for completeness)
 *   Company Admin → ALL on every module
 *   Sales Manager → CRU: Customers, Sales Invoices, Receipts, Sales Persons, Locations
 *                   RO : Dashboard, Products, Categories, Suppliers, Inventory, Reports
 *                   NONE: everything else
 *   Sales Person  → CR : Customers, Sales Invoices
 *                   RO : Dashboard, Products, Inventory
 *                   NONE: everything else
 *   Accountant    → CRU: Sales Invoices, Purchase Invoices, Payments, Receipts, Reports
 *                   RO : Dashboard, Customers, Suppliers, Products, Inventory, Tally Sync
 *                   NONE: everything else
 *
 * Idempotent: roles are matched by (company_id NULL, slug); permissions by slug;
 * grants use ON CONFLICT DO NOTHING. Safe to re-run.
 *
 * Module slugs are the lower-kebab of the 17 module display names.
 */

// ── system roles (display name → slug) ───────────────────────────────────
const ROLES = [
    { name: 'Super Admin',   slug: 'super-admin' },
    { name: 'Company Admin', slug: 'company-admin' },
    { name: 'Sales Manager', slug: 'sales-manager' },
    { name: 'Sales Person',  slug: 'sales-person' },
    { name: 'Accountant',    slug: 'accountant' },
];

// ── 17 modules: display name (as in mock.js) → kebab slug ─────────────────
const MODULES = [
    { name: 'Dashboard',         slug: 'dashboard' },
    { name: 'Companies',         slug: 'companies' },
    { name: 'Locations',         slug: 'locations' },
    { name: 'Sales Persons',     slug: 'sales-persons' },
    { name: 'Customers',         slug: 'customers' },
    { name: 'Suppliers',         slug: 'suppliers' },
    { name: 'Products',          slug: 'products' },
    { name: 'Categories',        slug: 'categories' },
    { name: 'Sales Invoices',    slug: 'sales-invoices' },
    { name: 'Purchase Invoices', slug: 'purchase-invoices' },
    { name: 'Payments',          slug: 'payments' },
    { name: 'Receipts',          slug: 'receipts' },
    { name: 'Inventory',         slug: 'inventory' },
    { name: 'Tally Sync',        slug: 'tally-sync' },
    { name: 'Reports',           slug: 'reports' },
    { name: 'Users',             slug: 'users' },
    { name: 'Settings',          slug: 'settings' },
];

const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

// ── permission presets — mirror of _perm(view, create, edit, delete, export)
const ALL  = ['view', 'create', 'edit', 'delete', 'export'];
const RO   = ['view', 'export'];                       // read + export
const CRU  = ['view', 'create', 'edit', 'export'];     // create/read/update + export
const CR   = ['view', 'create'];                       // create + read only
const NONE = [];

/**
 * Returns the list of granted actions for a given (roleSlug, moduleName),
 * mirroring web/data/mock.js `_buildRolePerms` exactly.
 */
function grantedActions(roleSlug, moduleName) {
    if (roleSlug === 'super-admin' || roleSlug === 'company-admin') {
        return ALL;
    }
    if (roleSlug === 'sales-manager') {
        if (['Customers', 'Sales Invoices', 'Receipts', 'Sales Persons', 'Locations'].includes(moduleName)) return CRU;
        if (['Dashboard', 'Products', 'Categories', 'Suppliers', 'Inventory', 'Reports'].includes(moduleName)) return RO;
        return NONE;
    }
    if (roleSlug === 'sales-person') {
        if (['Customers', 'Sales Invoices'].includes(moduleName)) return CR;
        if (['Dashboard', 'Products', 'Inventory'].includes(moduleName)) return RO;
        return NONE;
    }
    if (roleSlug === 'accountant') {
        if (['Sales Invoices', 'Purchase Invoices', 'Payments', 'Receipts', 'Reports'].includes(moduleName)) return CRU;
        if (['Dashboard', 'Customers', 'Suppliers', 'Products', 'Inventory', 'Tally Sync'].includes(moduleName)) return RO;
        return NONE;
    }
    return NONE;
}

exports.seed = async function (knex) {

    // 1) ROLES — insert each system role if absent; map slug → id.
    const roleIdBySlug = {};
    for (const role of ROLES) {
        let existing = await knex('roles')
            .whereNull('company_id')
            .andWhere('slug', role.slug)
            .first();
        if (!existing) {
            const [inserted] = await knex('roles')
                .insert({
                    company_id: null,
                    name:       role.name,
                    slug:       role.slug,
                    is_system:  true,
                })
                .returning('id');
            existing = inserted;
        }
        roleIdBySlug[role.slug] = existing.id;
    }
    console.log(`✓ roles: ${Object.entries(roleIdBySlug).map(([s, i]) => `${s}=${i}`).join(', ')}`);

    // 2) PERMISSIONS — 17 modules × 5 actions; insert if absent; map slug → id.
    const permIdBySlug = {};
    for (const mod of MODULES) {
        for (const action of ACTIONS) {
            const slug = `${mod.slug}.${action}`;
            let existing = await knex('permissions').where('slug', slug).first();
            if (!existing) {
                const [inserted] = await knex('permissions')
                    .insert({ module: mod.slug, action, slug })
                    .returning('id');
                existing = inserted;
            }
            permIdBySlug[slug] = existing.id;
        }
    }
    console.log(`✓ permissions: ${Object.keys(permIdBySlug).length} present (expected ${MODULES.length * ACTIONS.length})`);

    // 3) ROLE_PERMISSIONS — apply the matrix; ON CONFLICT DO NOTHING.
    let granted = 0;
    for (const role of ROLES) {
        const roleId = roleIdBySlug[role.slug];
        for (const mod of MODULES) {
            const actions = grantedActions(role.slug, mod.name);
            for (const action of actions) {
                const permId = permIdBySlug[`${mod.slug}.${action}`];
                if (!permId) continue;
                await knex('role_permissions')
                    .insert({ role_id: roleId, permission_id: permId })
                    .onConflict(['role_id', 'permission_id'])
                    .ignore();
                granted++;
            }
        }
    }
    console.log(`✓ role_permissions: ${granted} grants applied across ${ROLES.length} roles`);
};
