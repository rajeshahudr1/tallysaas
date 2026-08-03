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
const { entitledSlugSet } = require('../Helpers/entitlements');

const FORBIDDEN_MSG = 'You do not have permission to perform this action.';
const PLAN_MSG = 'This feature is not included in your plan. Please contact your administrator.';

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
            if (!perms.has(required)) return R.errorResponse(res, FORBIDDEN_MSG, 403);
            // PLAN GATE — even a company-admin (whose role has every permission)
            // is blocked from a module the LICENCE's plan is not entitled to. A
            // licence with no explicit entitlements resolves to ALL, so existing
            // licences keep full access until a plan is set.
            const licenseId = user.license_id;
            if (licenseId) {
                const entitled = await entitledSlugSet(licenseId);
                if (entitled && !entitled.has(required)) return R.errorResponse(res, PLAN_MSG, 403);
            }
            return next();
        } catch (err) {
            console.error('rbac.can error:', err);
            // Fail closed — a lookup failure must not grant access.
            return R.errorResponse(res, FORBIDDEN_MSG, 403);
        }
    };
}

/**
 * Field-sales (SFA) gate. A LINKED salesman is entitled to their own field
 * views simply BY BEING a salesman — their custom role need not carry a
 * `field-sales.view` grant (and it usually won't). Everyone else (admins /
 * managers who monitor field sales) must hold `field-sales.view`. Must run
 * AFTER resolveLocation (which sets req.isSalesman).
 */
function canField(req, res, next) {
    const user = req.user || {};
    if (user.role_slug === 'super-admin') return next();
    if (req.isSalesman) return next();               // being a salesman IS the entitlement
    return can('field-sales', 'view')(req, res, next);
}

/**
 * Customer-READ gate. A field salesman needs to SEE their customers to pick one
 * when creating an invoice / receipt, even though their role usually does NOT
 * carry `customers.view` (they don't manage the master). Being a LINKED salesman
 * IS the entitlement — and CustomerController.list already narrows the result to
 * ONLY the customers assigned to them (sales_person_customers), so a salesman
 * reads their assigned customers and nothing more. Everyone else must hold
 * `customers.view`. Must run AFTER resolveLocation (sets req.isSalesman).
 *
 * This gates ONLY reads (GET list + GET one). Create/edit/delete stay on the
 * strict can('customers', …) so a salesman still can't manage the master.
 */
function canCustomerRead(req, res, next) {
    const user = req.user || {};
    if (user.role_slug === 'super-admin') return next();
    if (req.isSalesman) return next();               // linked salesman → assigned customers only
    if (req.isCustomerUser) return next();           // customer login → ONLY their own row
    return can('customers', 'view')(req, res, next);
}

/**
 * Reference-list READ gate. Small REFERENCE masters (categories, locations, …)
 * are just LABELS used to populate filter dropdowns and forms. A field salesman
 * who can view inventory/invoices needs to read them to FILTER, even though
 * their role doesn't carry categories.view / locations.view. Being a linked
 * salesman IS the entitlement (mirrors canField / canCustomerRead); everyone
 * else needs the module's own `.view`. Gates ONLY the list/get read — write
 * stays on the strict can(module, …). `module` is the ref master's slug.
 */
function canRefRead(module) {
    return function refReadMiddleware(req, res, next) {
        const user = req.user || {};
        if (user.role_slug === 'super-admin') return next();
        if (req.isSalesman) return next();           // salesman reads reference labels
        if (req.isCustomerUser) return next();       // customer login reads its OWN scoped refs
        return can(module, 'view')(req, res, next);
    };
}

/**
 * Product-READ gate. A customer-portal login (customers.user_id link) needs to
 * SEE products to build an order/invoice, even though their role usually does
 * NOT carry `products.view`. Being a LINKED customer IS the entitlement — and
 * ProductController narrows their list to ONLY the assigned catalog (at the
 * locked adjusted rate), so they read their catalog and nothing more. Everyone
 * else (salesmen included — unchanged behaviour) must hold `products.view`.
 * Gates ONLY reads; writes stay on the strict can('products', …).
 */
function canProductRead(req, res, next) {
    const user = req.user || {};
    if (user.role_slug === 'super-admin') return next();
    if (req.isCustomerUser) return next();           // linked customer → own catalog only
    return can('products', 'view')(req, res, next);
}

/**
 * Own-invoice gate (sales invoices). A customer-portal / website-user login
 * creates + reads THEIR OWN invoices even when their role carries no
 * sales-invoices grant — being the LINKED customer IS the entitlement. The
 * controller already forces customer_id to their own row, recomputes locked
 * rates, scopes list/get to their customer, and routes them through the
 * approval queue — so this can never touch anyone else's data. Everyone else
 * stays on the strict can('sales-invoices', action). Only 'view'/'create' are
 * ever granted this way (approve/reject/delete stay strict + are additionally
 * 403'd for portal logins in the controller).
 */
function canOwnInvoice(action) {
    return function ownInvoiceMiddleware(req, res, next) {
        const user = req.user || {};
        if (user.role_slug === 'super-admin') return next();
        if (req.isCustomerUser && (action === 'view' || action === 'create')) return next();
        return can('sales-invoices', action)(req, res, next);
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
    canField,
    canCustomerRead,
    canRefRead,
    canProductRead,
    canOwnInvoice,
    clearCache,
    loadRolePermissions,
    FORBIDDEN_MSG,
};
