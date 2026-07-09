'use strict';

/**
 * web/config/rbacPaths.js
 *
 * The single source of truth mapping a URL's first path segment → its RBAC
 * module slug. Used in two places so they can never drift:
 *   • routes/web.js — the route guard that blocks a hand-typed URL to a module
 *     (and now a per-ACTION sub-path like /products/add) the role can't do.
 *   • index.js res.locals.canPath() — the view helper the partials use to HIDE
 *     the Add / Edit / Delete buttons the role can't do.
 *
 * A URL segment can differ from the module key (einvoices → einvoice) or borrow
 * another module's perm (reminders → payments, analytics → reports,
 * accountant-access → users).
 */

const PATH_TO_MODULE = {
    companies: 'companies', locations: 'locations', 'sales-persons': 'sales-persons',
    customers: 'customers', suppliers: 'suppliers', products: 'products',
    categories: 'categories', 'sales-invoices': 'sales-invoices',
    'purchase-invoices': 'purchase-invoices', payments: 'payments',
    receipts: 'receipts', journals: 'journals', inventory: 'inventory',
    reports: 'reports', users: 'users',
    'bank-reconciliation': 'bank-reconciliation', 'recurring-invoices': 'recurring-invoices',
    einvoices: 'einvoice', expenses: 'expenses', analytics: 'reports',
    'accountant-access': 'users', reminders: 'payments', settings: 'settings',
};

/** Resolve a URL path (or bare segment) to its module slug, or null if unknown. */
function moduleForPath(p) {
    const seg = String(p || '').split('/').filter(Boolean)[0];
    if (!seg) return null;
    return PATH_TO_MODULE[seg.toLowerCase()] || null;
}

module.exports = { PATH_TO_MODULE, moduleForPath };
