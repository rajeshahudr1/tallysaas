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

// Platform/admin roles a tenant can never assign or clone. These are also the
// two PROTECTED system roles that can never be edited or deleted by anyone
// (super-admin OR company-admin) — they are the fixed default roles.
const PROTECTED_SLUGS = ['super-admin', 'company-admin'];

// True when the authenticated caller is the platform Super Admin. The super-
// admin manages roles ACROSS every license (templates + any license's custom
// roles) and is never blocked by the "must have a license" guard.
function isSuper(req) {
    return !!(req.user && req.user.role_slug === 'super-admin');
}

function labelOf(key) {
    return String(key || '').split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function slugify(name) {
    return String(name || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'role';
}

// Roles visible to a caller.
//   • Super Admin (super===true): EVERY role — the 2 protected system roles, all
//     other system roles, every license's custom roles, and global templates.
//   • License-admin: the global SYSTEM roles (minus the platform/admin roles) +
//     this license's own custom roles.
function visibleRolesQuery(licenseId, super_) {
    if (super_) {
        return db('roles');
    }
    if (licenseId == null) {
        // No license (and not super-admin) → only the global system roles; never
        // any license's custom roles. Explicit branch avoids a sentinel.
        return db('roles').where('is_system', true).whereNotIn('slug', PROTECTED_SLUGS);
    }
    return db('roles').where(function () {
        this.where(function () {
            this.where('is_system', true).whereNotIn('slug', PROTECTED_SLUGS);
        }).orWhere('license_id', licenseId);
    });
}

// Fetch a role this caller may EDIT/DELETE.
//   • License-admin: only a CUSTOM role owned by their own license.
//   • Super Admin: any NON-protected role (custom of any license OR a global
//     template; never the 2 PROTECTED_SLUGS system roles).
async function editableRole(req, id) {
    if (isSuper(req)) {
        const role = await db('roles').where({ id }).first();
        if (!role) return null;
        if (PROTECTED_SLUGS.includes(role.slug)) return null;   // never editable
        return role;
    }
    const licenseId = req.user && req.user.license_id;
    return db('roles').where({ id, license_id: licenseId, is_system: false }).first();
}

/** GET /roles — assignable roles for the Add/Edit User dropdown. */
async function list(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        const rows = await visibleRolesQuery(licenseId, isSuper(req))
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
        const super_    = isSuper(req);
        const rows = await visibleRolesQuery(licenseId, super_)
            .orderBy('id', 'asc').select('id', 'name', 'slug', 'is_system', 'license_id');

        // Counts: a super-admin sees the GLOBAL user count per role (they manage
        // across every license); a license-admin sees only their own license's
        // users so one license can't learn another's headcount.
        let countsQ = db('users').whereNull('deleted_at');
        if (!super_) countsQ = countsQ.where('license_id', licenseId != null ? licenseId : -1);
        const counts = await countsQ.groupBy('role_id').select('role_id').count({ c: '*' });
        const byRole = {};
        counts.forEach((c) => { byRole[c.role_id] = Number(c.c); });

        const data = rows.map((r) => ({
            id: r.id, name: r.name, slug: r.slug, is_system: r.is_system,
            license_id: r.license_id,
            // Super-admin may edit any NON-protected role (custom of any license OR
            // a global template). License-admin may edit only their own custom roles.
            editable: super_
                ? !PROTECTED_SLUGS.includes(r.slug)
                : (!r.is_system && r.license_id === licenseId),
            user_count: byRole[r.id] || 0,
        }));
        return R.successResponse(res, { data, meta: { total: data.length, page: 1, per_page: data.length } });
    } catch (err) {
        console.error('RoleController.manageList error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** GET /account/roles/available-permissions — modules/actions this caller may grant.
 *
 *   • Super Admin: the FULL permission catalogue (they define entitlements, and
 *     a global template role may use any permission). If a ?license_id=<n> is
 *     supplied (editing a specific license's role) the grid is scoped to THAT
 *     license's entitlements so the super-admin can't grant beyond it.
 *   • License-admin: only the modules/actions their own license is entitled to.
 */
async function availablePermissions(req, res) {
    try {
        const super_ = isSuper(req);
        const all = await db('permissions').select('module', 'action', 'slug').orderBy(['module', 'action']);

        // Resolve the entitled slug set this caller may pick from.
        let entitled;
        if (super_) {
            const targetLicense = Number(req.query.license_id);
            if (Number.isInteger(targetLicense) && targetLicense > 0) {
                entitled = new Set(await entitlements.licensePermissionSlugs(targetLicense));
            } else {
                // Global template / no specific license → the full catalogue.
                entitled = new Set(all.map((p) => p.slug));
            }
        } else {
            const licenseId = req.user && req.user.license_id;
            // Guard: a null license would make entitlements fall back to ALL and
            // leak the full catalogue. Only a licensed account may view this.
            if (!licenseId) {
                return R.errorResponse(res, 'Only a licensed account can manage roles.', 422);
            }
            entitled = new Set(await entitlements.licensePermissionSlugs(licenseId));
        }

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
        const super_    = isSuper(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);

        const role = await visibleRolesQuery(licenseId, super_).where('roles.id', id)
            .first('roles.id', 'roles.name', 'roles.slug', 'roles.is_system', 'roles.license_id');
        if (!role) return R.errorResponse(res, NOT_FOUND, 404);

        const perms = await db('role_permissions as rp')
            .join('permissions as p', 'p.id', 'rp.permission_id')
            .where('rp.role_id', id).select('p.slug');

        return R.successResponse(res, {
            id: role.id, name: role.name, slug: role.slug, is_system: role.is_system,
            license_id: role.license_id,
            editable: super_
                ? !PROTECTED_SLUGS.includes(role.slug)
                : (!role.is_system && role.license_id === licenseId),
            permissions: perms.map((p) => p.slug),
        });
    } catch (err) {
        console.error('RoleController.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** POST /account/roles — create a custom role.
 *
 *   • License-admin: role is scoped to THEIR license; permissions filtered to
 *     the license's entitlements.
 *   • Super Admin: may create a GLOBAL TEMPLATE role (no license — license_id
 *     NULL, is_system false) or one scoped to a chosen license (body.license_id).
 *     Permissions are filtered to that target license's entitlements, or — for a
 *     template — to the full catalogue. This is why the super-admin no longer
 *     422s here: the "must have a license" guard only applies to non-super users.
 */
async function create(req, res) {
    try {
        const super_ = isSuper(req);

        // Resolve which license (if any) this new role belongs to.
        let licenseId;
        if (super_) {
            const bodyLicense = Number(req.body.license_id);
            licenseId = (Number.isInteger(bodyLicense) && bodyLicense > 0) ? bodyLicense : null;
        } else {
            licenseId = (req.user && req.user.license_id) || null;
            if (!licenseId) return R.errorResponse(res, 'Only a licensed account can create custom roles.', 422);
        }

        const name = String(req.body.name || '').trim();
        let slug = slugify(name);
        // Slug must be unique within its scope. For a license-scoped role that's
        // (license_id, slug); for a super-admin template (license_id NULL) we
        // de-dupe against other NULL-license roles by slug.
        const clashQ = licenseId != null
            ? db('roles').where({ license_id: licenseId, slug })
            : db('roles').whereNull('license_id').andWhere('slug', slug);
        const clash = await clashQ.first('id');
        if (clash) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;

        // Filter requested permissions to the entitled set. For a super-admin
        // template (no license) entitlements falls back to ALL.
        const requested = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        const entitled  = new Set(
            super_ && licenseId == null
                ? (await db('permissions').select('slug')).map((p) => p.slug)
                : await entitlements.licensePermissionSlugs(licenseId),
        );
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
        const id = Number(req.params.id);
        const role = await editableRole(req, id);
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
        const id = Number(req.params.id);
        const role = await editableRole(req, id);
        if (!role) return R.errorResponse(res, 'Role not found or not editable.', 404);

        // Filter to what the role's SCOPE may use: a license-scoped role → that
        // license's entitlements; a super-admin global template (license_id NULL)
        // → the full catalogue.
        const requested = Array.isArray(req.body.slugs) ? req.body.slugs : [];
        const entitled  = new Set(
            role.license_id == null
                ? (await db('permissions').select('slug')).map((p) => p.slug)
                : await entitlements.licensePermissionSlugs(role.license_id),
        );
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
        const id = Number(req.params.id);
        const role = await editableRole(req, id);
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
