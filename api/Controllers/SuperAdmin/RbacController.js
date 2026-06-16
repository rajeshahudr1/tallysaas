'use strict';

/**
 * api/Controllers/SuperAdmin/RbacController.js
 *
 * Roles & Permissions matrix. Roles are GLOBAL (shared across every tenant), so
 * editing a role's permissions is a PLATFORM operation — these endpoints are
 * Super-Admin only.
 *
 *   matrix                 GET  /permissions/matrix
 *       → everything the matrix UI needs: roles (+ user counts), the module
 *         list, the fixed action list, and the current { roleName: { module:
 *         { action: true } } } assignment map.
 *   updateRolePermissions  PUT  /roles/:id/permissions   { slugs: [...] }
 *       → replaces that role's permissions with the given slug whitelist (in a
 *         transaction). The Super Admin role is immutable (it bypasses RBAC).
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

// Pretty label for a module key: 'sales-invoices' → 'Sales Invoices'.
function labelOf(key) {
    return String(key || '').split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function matrix(req, res) {
    try {
        const roles = await db('roles').select('id', 'name', 'slug').orderBy('id', 'asc');

        const counts = await db('users').whereNull('deleted_at')
            .groupBy('role_id').select('role_id').count({ c: '*' });
        const countByRole = {};
        counts.forEach((r) => { countByRole[r.role_id] = Number(r.c); });

        const modKeys = (await db('permissions').distinct('module').orderBy('module', 'asc'))
            .map((r) => r.module);
        const modules = modKeys.map((k) => ({ key: k, label: labelOf(k) }));

        // Current assignments → { roleName: { module: { action: true } } }.
        const assigned = await db('role_permissions as rp')
            .join('permissions as p', 'p.id', 'rp.permission_id')
            .join('roles as r', 'r.id', 'rp.role_id')
            .select('r.name as role', 'p.module', 'p.action');
        const permissions = {};
        roles.forEach((r) => { permissions[r.name] = {}; });
        assigned.forEach((a) => {
            if (!permissions[a.role]) permissions[a.role] = {};
            if (!permissions[a.role][a.module]) permissions[a.role][a.module] = {};
            permissions[a.role][a.module][a.action] = true;
        });

        return R.successResponse(res, {
            roles: roles.map((r) => ({ id: r.id, name: r.name, slug: r.slug, user_count: countByRole[r.id] || 0 })),
            modules,
            actions: ACTIONS,
            permissions,
        });
    } catch (err) {
        console.error('RbacController.matrix error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

async function updateRolePermissions(req, res) {
    try {
        const id = Number(req.params.id);
        const role = await db('roles').where('id', id).first('id', 'slug', 'name');
        if (!role) return R.errorResponse(res, 'Role not found.', 404);
        if (role.slug === 'super-admin') {
            return R.errorResponse(res, 'The Super Admin role always has full access and cannot be edited.', 422);
        }

        const slugs = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        // Whitelist against real permissions (ignores anything unknown).
        const valid = slugs.length
            ? await db('permissions').whereIn('slug', slugs).select('id')
            : [];
        const permIds = valid.map((v) => v.id);

        await db.transaction(async (trx) => {
            await trx('role_permissions').where('role_id', id).del();
            if (permIds.length) {
                await trx('role_permissions').insert(permIds.map((pid) => ({ role_id: id, permission_id: pid })));
            }
        });

        return R.successResponse(res, { role_id: id, count: permIds.length },
            `Permissions updated for ${role.name}.`);
    } catch (err) {
        console.error('RbacController.updateRolePermissions error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /super-admin/licenses/:id/permissions
 * The module/action grid for ONE license + which permissions it is ENTITLED to.
 * A license with NO explicit license_permissions rows is entitled to ALL
 * (all_granted=true); otherwise only the explicit subset is "on". Backs the
 * Super Admin's per-license module-access screen.
 */
async function licenseMatrix(req, res) {
    try {
        const id = Number(req.params.id);
        const license = await db('licenses').where('id', id).whereNull('deleted_at')
            .first('id', 'holder_name');
        if (!license) return R.errorResponse(res, 'License not found.', 404);

        const allPerms = await db('permissions')
            .select('id', 'module', 'action', 'slug').orderBy(['module', 'action']);
        const modKeys = [...new Set(allPerms.map((p) => p.module))];
        const modules = modKeys.map((k) => ({ key: k, label: labelOf(k) }));

        const explicitRows = await db('license_permissions')
            .where('license_id', id).select('permission_id');
        const hasExplicit = explicitRows.length > 0;
        const grantedIds = new Set(explicitRows.map((r) => r.permission_id));

        // { module: { action: true } } — all-on when the license has no explicit set.
        const granted = {};
        for (const p of allPerms) {
            const on = hasExplicit ? grantedIds.has(p.id) : true;
            if (on) (granted[p.module] = granted[p.module] || {})[p.action] = true;
        }

        return R.successResponse(res, {
            license: { id: license.id, holder_name: license.holder_name },
            modules, actions: ACTIONS, granted, all_granted: !hasExplicit,
        });
    } catch (err) {
        console.error('RbacController.licenseMatrix error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * PUT /super-admin/licenses/:id/permissions   { slugs: [...] }
 * Replaces the license's entitled permission set with the given slug whitelist.
 * (An empty set leaves no explicit rows, which Helpers/entitlements treats as
 * "ALL" — i.e. you can't entitle a license to zero modules; grant a subset.)
 */
async function setLicensePermissions(req, res) {
    try {
        const id = Number(req.params.id);
        const license = await db('licenses').where('id', id).whereNull('deleted_at')
            .first('id', 'holder_name');
        if (!license) return R.errorResponse(res, 'License not found.', 404);

        const slugs = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        // Reject an empty grant: with no explicit rows a license falls back to
        // ALL modules (see Helpers/entitlements), which would surprise an admin
        // trying to restrict it. Require an explicit non-empty subset.
        if (!slugs.length) {
            return R.errorResponse(res, 'Select at least one module to grant this license.', 422);
        }
        const valid = await db('permissions').whereIn('slug', slugs).select('id');
        const permIds = valid.map((v) => v.id);

        await db.transaction(async (trx) => {
            await trx('license_permissions').where('license_id', id).del();
            if (permIds.length) {
                await trx('license_permissions')
                    .insert(permIds.map((pid) => ({ license_id: id, permission_id: pid })));
            }
        });

        return R.successResponse(res, { license_id: id, count: permIds.length },
            `Module access updated for ${license.holder_name}.`);
    } catch (err) {
        console.error('RbacController.setLicensePermissions error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { matrix, updateRolePermissions, licenseMatrix, setLicensePermissions };
