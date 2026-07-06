'use strict';

/**
 * 20260101000068_add_field_gps_modules.js
 *
 * Register the new SFA features as FIRST-CLASS RBAC modules so they show up in
 * the License-Modules entitlement grid (super-admin → company) AND the role
 * permission matrix (company-admin → users):
 *
 *   • field-sales  — the salesman field module (My Field, check-in, part-visit,
 *                    visits, field-tracking view, invoice approvals)
 *   • gps-tracking — the GPS tracking config + location trail
 *
 * The permissions grid reads `db('permissions').distinct('module')`, so seeding
 * these into `permissions` makes them appear automatically. We also grant every
 * action to the built-in admin roles (super-admin, company-admin) and add the
 * new permissions to EVERY existing license's explicit entitlement set so the
 * feature is available (and ticked) for licenses that already have an entitlement
 * row (a license with NO explicit rows is "all-entitled" by default, so it needs
 * nothing).
 */

const NEW_MODULES = ['field-sales', 'gps-tracking'];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

exports.up = async function up(knex) {
    // 1) Seed the permission rows.
    const permIds = [];
    for (const mod of NEW_MODULES) {
        for (const action of ACTIONS) {
            const slug = `${mod}.${action}`;
            let row = await knex('permissions').where('slug', slug).first('id');
            if (!row) {
                const [ins] = await knex('permissions').insert({ module: mod, action, slug }).returning('id');
                row = ins;
            }
            permIds.push(row.id);
        }
    }

    // 2) Grant every action to the built-in admin roles.
    const adminRoles = await knex('roles').whereNull('company_id')
        .whereIn('slug', ['super-admin', 'company-admin']).select('id');
    for (const r of adminRoles) {
        for (const pid of permIds) {
            await knex('role_permissions')
                .insert({ role_id: r.id, permission_id: pid })
                .onConflict(['role_id', 'permission_id']).ignore();
        }
    }

    // 3) Add to every license that has an explicit entitlement set (so it stays
    //    entitled + ticked). Licenses with no explicit rows = all-entitled already.
    const explicitLics = await knex('license_permissions').distinct('license_id').pluck('license_id');
    for (const lid of explicitLics) {
        for (const pid of permIds) {
            const exists = await knex('license_permissions').where({ license_id: lid, permission_id: pid }).first('license_id');
            if (!exists) await knex('license_permissions').insert({ license_id: lid, permission_id: pid });
        }
    }
};

exports.down = async function down(knex) {
    const slugs = [];
    for (const mod of NEW_MODULES) for (const a of ACTIONS) slugs.push(`${mod}.${a}`);
    const ids = await knex('permissions').whereIn('slug', slugs).pluck('id');
    if (ids.length) {
        await knex('license_permissions').whereIn('permission_id', ids).del();
        await knex('role_permissions').whereIn('permission_id', ids).del();
        await knex('permissions').whereIn('id', ids).del();
    }
};
