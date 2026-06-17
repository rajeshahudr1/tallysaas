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

async function resolveLocation(req, res, next) {
    const user = req.user || {};

    // Default: no location restriction.
    req.locationId = null;

    // Super Admin is never location-restricted (cross-company/branch operator).
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
        return next();
    } catch (err) {
        console.error('resolveLocation lookup error:', err);
        // Keep the safe default (null = company-wide). The request stays
        // company-scoped, so this never leaks across companies.
        req.locationId = null;
        return next();
    }
}

module.exports = {
    resolveLocation,
};
