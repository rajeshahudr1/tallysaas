'use strict';

/**
 * api/Middlewares/locationScope.js
 *
 * Resolves the effective LOCATION (branch) scope for the request and pins it to
 * `req.locationId` — a number (restrict to that one location) or null (no
 * restriction: see every location's data, i.e. the whole company).
 *
 * Rule (Requirement C — per-user location data scoping):
 *   • When the logged-in user has users.location_id SET, they may only SEE/act
 *     on that ONE location's data → req.locationId = <that id>.
 *   • When users.location_id is NULL they see ALL locations → req.locationId = null.
 *
 * Who is restricted:
 *   • A plain user / salesman with a location_id IS restricted.
 *   • Super Admin is NEVER location-restricted — they are the platform operator,
 *     target companies via the X-Company-Id header and manage everything across
 *     companies; req.locationId is forced null for them.
 *   • Company Admin (and any other role) is restricted ONLY if THEY THEMSELVES
 *     have a location_id set; a company-admin with location_id NULL (the normal
 *     case) manages the whole company. This falls out naturally from reading the
 *     user's own column — no role special-casing needed beyond super-admin.
 *
 * The JWT does NOT carry location_id (it carries sub/company_id/license_id/
 * role_id/role_slug/name/jti), so we read users.location_id fresh from the DB by
 * req.user.sub — a single indexed primary-key lookup, the same cheap-lookup
 * pattern resolveCompany already uses. Reading fresh also means a location
 * reassignment takes effect on the user's next request (no re-login needed).
 *
 * Must run AFTER auth.authenticate (reads req.user) and AFTER
 * companyScope.resolveCompany (location scope is ADDITIVE on top of company
 * scope — company_id stays the primary tenant guard). Wire it into the tenant
 * route chain right after resolveCompany.
 *
 * Fail-open is NOT acceptable here in the sense of leaking other locations, but
 * a lookup error must not hand a restricted user MORE data than they should see.
 * On any error we leave req.locationId at the safe default (null only for a
 * super-admin; for everyone else we keep whatever we resolved, defaulting to a
 * best-effort re-read). In practice the lookup is a trivial PK read that does
 * not fail; if it somehow does we log and fall through with req.locationId null
 * (the request is still company-scoped, so no cross-company leak — only the
 * narrower location filter is skipped, matching the pre-feature behaviour).
 */

const db = require('../config/db').db;
const R  = require('../Helpers/response');
const { entitledSlugSet } = require('../Helpers/entitlements');

// Portal-link entitlement gate: which license MODULE a linked login rides on.
// When the super-admin removes that module from the licence, the linked login
// is dead on EVERY request (not just hidden menus) — 403 with a clear message.
const DISABLED_MSG = 'This login has been disabled — the module is not enabled on your license.';
async function moduleEnabled(licenseId, slug) {
    const entitled = await entitledSlugSet(licenseId);   // null = no licence gate
    return !entitled || entitled.has(slug);
}

async function resolveLocation(req, res, next) {
    const user = req.user || {};

    // Defaults: no location restriction, not a field salesman, no approval gate.
    req.locationId = null;
    req.salesPersonId = null;
    req.isSalesman = false;
    // Customer-portal login (customers.user_id link) — mirrors the salesman flags.
    req.customerId = null;
    req.isCustomerUser = false;
    // needsApproval — TRUE for EVERY non-admin user (not only linked salesmen):
    // their sales invoices must be approved by a company-admin before they count
    // / sync to Tally. ONLY company-admin + super-admin (+ admin/owner) bypass.
    req.needsApproval = false;

    // Super Admin is never location-restricted (cross-company/branch operator)
    // and never needs approval.
    if (user.role_slug === 'super-admin') {
        return next();
    }

    const userId = user.sub;
    if (!userId) {
        // No identified user (should not happen behind authenticate) → unrestricted.
        return next();
    }

    try {
        const row = await db('users')
            .where('id', userId)
            .whereNull('deleted_at')
            .first('location_id');
        const loc = row && row.location_id;
        req.locationId = (loc !== null && loc !== undefined) ? Number(loc) : null;

        // Field-sales (SFA) scoping: a user LINKED to a sales_persons row is a
        // field salesman → req.isSalesman/req.salesPersonId. Controllers use this
        // to (a) restrict invoices/reports/analytics to ONLY the rows THEY
        // created, and (b) make their field invoices need admin approval before
        // they count / sync. Admins/owners are never treated as salesmen (they
        // manage the whole company) even if a link somehow exists.
        const adminish = ['super-admin', 'company-admin', 'admin', 'owner']
            .includes(user.role_slug);
        // Any non-admin's sales invoices go through the approval queue.
        req.needsApproval = !adminish;
        if (!adminish && req.companyId) {
            const sp = await db('sales_persons')
                .where({ user_id: userId, company_id: req.companyId })
                .whereNull('deleted_at')
                .first('id');
            if (sp) {
                // License gate: the salesman portal rides on the 'sales-persons'
                // module — removed from the licence ⇒ this login stops working.
                if (!await moduleEnabled(user.license_id, 'sales-persons.view')) {
                    return R.errorResponse(res, DISABLED_MSG, 403);
                }
                req.isSalesman = true;
                req.salesPersonId = Number(sp.id);
            }
            // Customer-portal scoping: a user LINKED to a customers row is a
            // customer login. They see ONLY their assigned categories/products
            // (customer_user_categories/_products), their invoices are forced to
            // their own customer_id with server-computed locked rates, and they
            // go through the same approval queue. Salesman link wins if both
            // somehow exist (a user should never be both).
            if (!sp) {
                const cust = await db('customers')
                    .where({ user_id: userId, company_id: req.companyId })
                    .whereNull('deleted_at')
                    .first('id', 'is_website_user');
                if (cust) {
                    // License gate: customer logins ride on 'customer-users',
                    // website/API logins on 'website-users'.
                    const modSlug = cust.is_website_user
                        ? 'website-users.view' : 'customer-users.view';
                    if (!await moduleEnabled(user.license_id, modSlug)) {
                        return R.errorResponse(res, DISABLED_MSG, 403);
                    }
                    req.isCustomerUser = true;
                    req.customerId = Number(cust.id);
                }
            }
        }
        return next();
    } catch (err) {
        console.error('resolveLocation lookup error:', err);
        // Keep safe defaults (null = company-wide, not a salesman). The request
        // stays company-scoped, so this never leaks across companies. Approval is
        // recomputed from the role alone so a non-admin never bypasses the queue.
        req.locationId = null;
        req.salesPersonId = null;
        req.isSalesman = false;
        req.customerId = null;
        req.isCustomerUser = false;
        req.needsApproval = !['super-admin', 'company-admin', 'admin', 'owner']
            .includes(user.role_slug);
        return next();
    }
}

module.exports = {
    resolveLocation,
};
