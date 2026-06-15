'use strict';

/**
 * api/Middlewares/rbac.js
 *
 * Role-Based Access Control. `can(module, action)` returns an Express
 * middleware that allows the request only if the authenticated user's role
 * has the matching permission (slug `module.action`, e.g. 'customers.create').
 *
 * Rules (spec §4):
 *   • Super Admin (role_slug === 'super-admin') bypasses all checks.
 *   • Everyone else: the role's permission set is looked up via the
 *     role_permissions → permissions join and checked for the required slug.
 *   • Denied → 403 envelope.
 *
 * Permission sets are looked up per role_id and cached in-process (a Map keyed
 * by role_id holding a Set of slugs). The cache is fine for this app's scale;
 * `clearCache()` is exported so a seed/admin flow can invalidate it after
 * editing a role's permissions. Must run AFTER auth.authenticate.
 */

const R  = require('../Helpers/response');
const db = require('../config/db').db;

const FORBIDDEN_MSG = 'You do not have permission to perform this action.';

// role_id → Set<'module.action'>. Lazy-filled on first check for a role.
const _permCache = new Map();

/**
 * Load (and cache) the set of permission slugs granted to a role.
 * Returns a Set of strings like 'customers.create'.
 */
async function loadRolePermissions(roleId) {
    if (_permCache.has(roleId)) return _permCache.get(roleId);

    const rows = await db('role_permissions as rp')
        .join('permissions as p', 'p.id', 'rp.permission_id')
        .where('rp.role_id', roleId)
        .select('p.slug');

    const set = new Set(rows.map((r) => r.slug));
    _permCache.set(roleId, set);
    return set;
}

/**
 * Build a middleware that requires `<module>.<action>` permission.
 *
 *   router.post('/customers', authenticate, resolveCompany,
 *               can('customers', 'create'), CustomerController.create);
 */
function can(module, action) {
    const required = `${module}.${action}`;

    return async function rbacMiddleware(req, res, next) {
        const user = req.user || {};

        // Super Admin bypasses RBAC entirely.
        if (user.role_slug === 'super-admin') return next();

        if (!user.role_id) {
            return R.errorResponse(res, FORBIDDEN_MSG, 403);
        }

        try {
            const perms = await loadRolePermissions(user.role_id);
            if (perms.has(required)) return next();
            return R.errorResponse(res, FORBIDDEN_MSG, 403);
        } catch (err) {
            console.error('rbac.can error:', err);
            // Fail closed — a lookup failure must not grant access.
            return R.errorResponse(res, FORBIDDEN_MSG, 403);
        }
    };
}

/**
 * Invalidate the in-process permission cache. Call after a role's permissions
 * change (whole cache, or a single role_id).
 */
function clearCache(roleId) {
    if (roleId === undefined) _permCache.clear();
    else _permCache.delete(roleId);
}

module.exports = {
    can,
    clearCache,
    loadRolePermissions,
    FORBIDDEN_MSG,
};
