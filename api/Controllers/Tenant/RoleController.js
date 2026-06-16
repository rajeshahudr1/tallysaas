'use strict';

/**
 * api/Controllers/Tenant/RoleController.js
 *
 * Tenant (license-admin) role management — Phase C.
 *
 * A license-admin may create CUSTOM roles for their license and assign ONLY the
 * permissions their license is ENTITLED to (Helpers/entitlements, granted by the
 * Super Admin). They may NOT touch the global SYSTEM roles, and the platform
 * roles (super-admin, company-admin) are never assignable/clonable by a tenant.
 *
 *   list                 GET    /roles                  (assignable roles → user-form dropdown)
 *   manageList           GET    /account/roles          (custom roles of this license + counts)
 *   availablePermissions GET    /account/roles/available-permissions
 *   get                  GET    /account/roles/:id      (role + its permission slugs)
 *   create               POST   /account/roles          ({name, slugs?})
 *   update               PUT    /account/roles/:id      ({name})  rename
 *   setPermissions       PUT    /account/roles/:id/permissions  ({slugs})
 *   remove               DELETE /account/roles/:id
 *
 * Custom roles are LICENSE-scoped (roles.license_id = the admin's license,
 * company_id NULL, is_system false). The rbac permission cache is invalidated on
 * every change so checks reflect new grants immediately.
 */

const crypto       = require('node:crypto');
const R            = require('../../Helpers/response');
const db           = require('../../config/db').db;
const rbac         = require('../../Middlewares/rbac');
const entitlements = require('../../Helpers/entitlements');

const OOPS      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND = 'Role not found.';

// Platform/admin roles a tenant can never assign or clone.
const PROTECTED_SLUGS = ['super-admin', 'company-admin'];

function labelOf(key) {
    return String(key || '').split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function slugify(name) {
    return String(name || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'role';
}

// Roles visible to a license: global SYSTEM roles (minus the platform/admin
// roles) + this license's own custom roles.
function visibleRolesQuery(licenseId) {
    if (licenseId == null) {
        // No license (e.g. the platform super-admin) → only the global system
        // roles; never any license's custom roles. Explicit branch avoids a
        // sentinel like license_id = -1.
        return db('roles').where('is_system', true).whereNotIn('slug', PROTECTED_SLUGS);
    }
    return db('roles').where(function () {
        this.where(function () {
            this.where('is_system', true).whereNotIn('slug', PROTECTED_SLUGS);
        }).orWhere('license_id', licenseId);
    });
}

// Fetch a CUSTOM role owned by this license (the only kind a tenant may edit).
function ownedCustomRole(licenseId, id) {
    return db('roles').where({ id, license_id: licenseId, is_system: false }).first();
}

/** GET /roles — assignable roles for the Add/Edit User dropdown. */
async function list(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const rows = await visibleRolesQuery(licenseId)
            .orderBy('id', 'asc').select('id', 'name', 'slug', 'is_system', 'license_id');
        return R.successResponse(res, {
            data: rows, meta: { total: rows.length, page: 1, per_page: rows.length },
        });
    } catch (err) {
        console.error('RoleController.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** GET /account/roles — role-management list (with per-role user counts). */
async function manageList(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const rows = await visibleRolesQuery(licenseId)
            .orderBy('id', 'asc').select('id', 'name', 'slug', 'is_system', 'license_id');

        // Scope counts to THIS license's users so one license can't see how many
        // users another license has on a (shared system) role.
        const counts = await db('users').whereNull('deleted_at')
            .where('license_id', licenseId != null ? licenseId : -1)
            .groupBy('role_id').select('role_id').count({ c: '*' });
        const byRole = {};
        counts.forEach((c) => { byRole[c.role_id] = Number(c.c); });

        const data = rows.map((r) => ({
            id: r.id, name: r.name, slug: r.slug, is_system: r.is_system,
            editable: !r.is_system && r.license_id === licenseId,
            user_count: byRole[r.id] || 0,
        }));
        return R.successResponse(res, { data, meta: { total: data.length, page: 1, per_page: data.length } });
    } catch (err) {
        console.error('RoleController.manageList error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** GET /account/roles/available-permissions — modules/actions this license may use. */
async function availablePermissions(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        // Guard: a null license would make entitlements fall back to ALL and leak
        // the full permission catalogue. Only a licensed account may view this.
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can manage roles.', 422);
        }
        const entitled = new Set(await entitlements.licensePermissionSlugs(licenseId));
        const all = await db('permissions').select('module', 'action', 'slug').orderBy(['module', 'action']);
        const allowed = all.filter((p) => entitled.has(p.slug));
        const modKeys = [...new Set(allowed.map((p) => p.module))];
        const modules = modKeys.map((k) => ({
            key: k, label: labelOf(k),
            actions: allowed.filter((p) => p.module === k).map((p) => p.action),
        }));
        return R.successResponse(res, { modules, slugs: [...entitled] });
    } catch (err) {
        console.error('RoleController.availablePermissions error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** GET /account/roles/:id — a visible role + its permission slugs. */
async function get(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);

        const role = await visibleRolesQuery(licenseId).where('roles.id', id)
            .first('roles.id', 'roles.name', 'roles.slug', 'roles.is_system', 'roles.license_id');
        if (!role) return R.errorResponse(res, NOT_FOUND, 404);

        const perms = await db('role_permissions as rp')
            .join('permissions as p', 'p.id', 'rp.permission_id')
            .where('rp.role_id', id).select('p.slug');

        return R.successResponse(res, {
            id: role.id, name: role.name, slug: role.slug, is_system: role.is_system,
            editable: !role.is_system && role.license_id === licenseId,
            permissions: perms.map((p) => p.slug),
        });
    } catch (err) {
        console.error('RoleController.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** POST /account/roles — create a license-scoped custom role. */
async function create(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        if (!licenseId) return R.errorResponse(res, 'Only a licensed account can create custom roles.', 422);

        const name = String(req.body.name || '').trim();
        let slug = slugify(name);
        const clash = await db('roles').where({ license_id: licenseId, slug }).first('id');
        if (clash) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;

        // Filter requested permissions to the license's entitled set.
        const requested = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        const entitled  = new Set(await entitlements.licensePermissionSlugs(licenseId));
        const allowed   = requested.filter((s) => entitled.has(s));
        const permRows  = allowed.length
            ? await db('permissions').whereIn('slug', allowed).select('id') : [];

        const role = await db.transaction(async (trx) => {
            const [r] = await trx('roles')
                .insert({ license_id: licenseId, company_id: null, name, slug, is_system: false })
                .returning(['id', 'name', 'slug']);
            if (permRows.length) {
                await trx('role_permissions').insert(permRows.map((p) => ({ role_id: r.id, permission_id: p.id })));
            }
            return r;
        });
        rbac.clearCache(role.id);

        return R.successResponse(res,
            { id: role.id, name: role.name, slug: role.slug, permission_count: permRows.length },
            'Role created.');
    } catch (err) {
        // Unique-violation on (license_id, slug) — a concurrent create raced us.
        if (err && err.code === '23505') {
            return R.errorResponse(res, 'A role with that name already exists in your account. Please use a different name.', 422);
        }
        console.error('RoleController.create error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** PUT /account/roles/:id — rename a custom role. */
async function update(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = Number(req.params.id);
        const role = await ownedCustomRole(licenseId, id);
        if (!role) return R.errorResponse(res, 'Role not found or not editable.', 404);

        const name = String(req.body.name || '').trim();
        if (!name) return R.errorResponse(res, 'Role name is required.', 422);

        await db('roles').where('id', id).update({ name, updated_at: new Date() });
        rbac.clearCache(id);   // defensive: invalidate on any role mutation
        return R.successResponse(res, { id, name }, 'Role updated.');
    } catch (err) {
        console.error('RoleController.update error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** PUT /account/roles/:id/permissions — set permissions (filtered to entitled). */
async function setPermissions(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = Number(req.params.id);
        const role = await ownedCustomRole(licenseId, id);
        if (!role) return R.errorResponse(res, 'Role not found or not editable.', 404);

        const requested = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        const entitled  = new Set(await entitlements.licensePermissionSlugs(licenseId));
        const allowed   = requested.filter((s) => entitled.has(s));
        const permRows  = allowed.length
            ? await db('permissions').whereIn('slug', allowed).select('id') : [];

        await db.transaction(async (trx) => {
            await trx('role_permissions').where('role_id', id).del();
            if (permRows.length) {
                await trx('role_permissions').insert(permRows.map((p) => ({ role_id: id, permission_id: p.id })));
            }
        });
        rbac.clearCache(id);

        return R.successResponse(res, { role_id: id, count: permRows.length }, 'Permissions updated.');
    } catch (err) {
        console.error('RoleController.setPermissions error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** DELETE /account/roles/:id — delete a custom role (only if unused). */
async function remove(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const id = Number(req.params.id);
        const role = await ownedCustomRole(licenseId, id);
        if (!role) return R.errorResponse(res, 'Role not found or not editable.', 404);

        const inUse = await db('users').where('role_id', id).whereNull('deleted_at').first('id');
        if (inUse) {
            return R.errorResponse(res, 'This role is assigned to one or more users; reassign them first.', 422);
        }

        await db.transaction(async (trx) => {
            await trx('role_permissions').where('role_id', id).del();
            await trx('roles').where('id', id).del();
        });
        rbac.clearCache(id);

        return R.successResponse(res, { id }, 'Role deleted.');
    } catch (err) {
        console.error('RoleController.remove error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = {
    list, manageList, availablePermissions, get, create, update, setPermissions, remove,
};
