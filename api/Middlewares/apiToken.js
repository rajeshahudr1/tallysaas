'use strict';

/**
 * api/Middlewares/apiToken.js
 *
 * Third-party API authentication for the /ext/* routes via the website user's
 * api_token (minted by WebsiteUserController as `wt_<licenseId>_<40 hex>` —
 * the licence prefix routes us to the right tenant DB without a JWT).
 *
 * Token comes as `X-Api-Token: <token>` (or `Authorization: Bearer wt_...`).
 * On success the request looks EXACTLY like a logged-in customer-portal user:
 *   req.user           — the linked login user (sub / role_slug / license_id …)
 *   req.companyId      — the website user's company
 *   req.isCustomerUser — true, req.customerId = the website-user customer row
 *   req.needsApproval  — true (third-party invoices enter the approval queue)
 * and the tenant Knex is bound via runWithTenant, so every controller works
 * unchanged (scoped catalog, locked rates, forced customer_id).
 *
 * Failures are a uniform 401 (no token-format hints leak).
 */

const R      = require('../Helpers/response');
const tenant = require('../config/tenantDb');
const { runWithTenant } = require('../config/db');

const AUTH_FAIL = 'Invalid or missing API token.';
const TOKEN_RE  = /^wt_(\d{1,10})_[a-f0-9]{40}$/i;

async function authenticateApiToken(req, res, next) {
    try {
        let token = String(req.headers['x-api-token'] || '').trim();
        if (!token) {
            const auth = String(req.headers.authorization || '');
            if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
        }
        const m = TOKEN_RE.exec(token);
        if (!m) return R.errorResponse(res, AUTH_FAIL, 401);
        const licenseId = Number(m[1]);

        let tk;
        try {
            tk = tenant.getKnexForLicense(licenseId);
        } catch (_) {
            return R.errorResponse(res, AUTH_FAIL, 401);
        }

        // License gate: the third-party token API rides on the 'website-users'
        // module — removed from the licence ⇒ every token stops working.
        const { entitledSlugSet } = require('../Helpers/entitlements');
        const entitled = await entitledSlugSet(licenseId);
        if (entitled && !entitled.has('website-users.view')) {
            return R.errorResponse(res, AUTH_FAIL, 401);
        }

        const cust = await tk('customers')
            .where('api_token', token)
            .where('is_website_user', true)
            .whereNull('deleted_at')
            .first('id', 'company_id', 'user_id', 'status', 'name');
        if (!cust || cust.status !== 'Active' || !cust.user_id) {
            return R.errorResponse(res, AUTH_FAIL, 401);
        }

        const user = await tk('users')
            .where('id', cust.user_id)
            .whereNull('deleted_at')
            .first('id', 'role_id', 'status', 'name', 'email');
        if (!user || user.status !== 'Active') {
            return R.errorResponse(res, AUTH_FAIL, 401);
        }
        const role = user.role_id
            ? await tk('roles').where('id', user.role_id).first('slug')
            : null;

        // Shape the request like an authenticated customer-portal session.
        req.user = {
            sub:        Number(user.id),
            name:       user.name,
            email:      user.email,
            role_id:    user.role_id,
            role_slug:  (role && role.slug) || 'website-user',
            license_id: licenseId,
            db_name:    tenant.dbNameForLicense(licenseId),
            via:        'api-token',
        };
        req.db             = tk;
        req.companyId      = Number(cust.company_id);
        req.locationId     = null;
        req.isSalesman     = false;
        req.salesPersonId  = null;
        req.isCustomerUser = true;
        req.customerId     = Number(cust.id);
        req.needsApproval  = true;

        return runWithTenant(tk, () => next());
    } catch (err) {
        console.error('authenticateApiToken error:', err);
        return R.errorResponse(res, AUTH_FAIL, 401);
    }
}

/**
 * EXT full-access mode — for the /ext/* INTEGRATION endpoints (customer CRUD,
 * invoice list/details BY customer). Runs AFTER authenticateApiToken and lifts
 * the portal self-scoping (req.isCustomerUser/customerId) so the token can
 * manage the COMPANY's customers and read any customer's invoices — the token
 * is the company's integration credential. Catalog pricing / forced-self rules
 * stay on the portal-style routes that don't use this.
 */
function extFullAccess(req, _res, next) {
    req.isCustomerUser = false;
    req.customerId = null;
    return next();
}

module.exports = { authenticateApiToken, extFullAccess };
