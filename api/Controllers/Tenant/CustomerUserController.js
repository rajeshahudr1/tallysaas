'use strict';

/**
 * api/Controllers/Tenant/CustomerUserController.js
 *
 * Customer-User (customer portal login) endpoints layered on the customers
 * resource — the exact pattern SalesPersonController uses for its bespoke
 * login/assignment endpoints:
 *
 *   POST /customers/:id/login       — create/link the login user (atomic)
 *   PUT  /customers/:id/catalog     — replace assigned categories (+ pricing %,
 *                                     + optional per-category product narrowing)
 *   GET  /customers/:id/assignments — prefill payload for the edit form
 *
 * All three are company-scoped (req.companyId) and soft-delete aware, guarded by
 * the same chain as the customers CRUD (authenticate → resolveTenant →
 * resolveCompany → resolveLocation → can('customers', …)) — so a role without
 * customers.edit gets a server-side 403 no matter what the UI shows.
 *
 * Pricing model (consumed by ProductController list + InvoiceController create
 * for the LINKED login): per assigned category,
 *   rate = sales_price × (1 − discount_pct/100) × (1 + addition_pct/100)
 * customer_user_products rows narrow a category to specific items; a category
 * with NO product rows allows every product in it. The linked login's invoice
 * rates are always server-computed from this config — client rates are ignored.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { hash } = require('../../Helpers/passwords');
const { EMAIL_TAKEN_MSG } = require('../../Helpers/emailUnique');
const { emailTakenAcrossPlanes, createLicensedUser, patchLicensedUser } = require('../../Helpers/tenantUsers');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Customer not found.';

// Load the company-scoped, non-deleted customer row or null.
async function fetchCustomer(companyId, id) {
    return db('customers')
        .where('company_id', companyId)
        .where('id', id)
        .whereNull('deleted_at')
        .first();
}

/** Round to 2 decimals (money). */
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/** Effective locked rate for a product under a category's pricing knobs. */
function effectiveRate(salesPrice, discountPct, additionPct) {
    const base = Number(salesPrice) || 0;
    const disc = Number(discountPct) || 0;
    const add  = Number(additionPct) || 0;
    return round2(base * (1 - disc / 100) * (1 + add / 100));
}

/**
 * The catalog config for a customer:
 *   { categories: Map<category_id, {discount_pct, addition_pct}>,
 *     productsByCategory: Map<category_id, Set<product_id>> }   // narrowing sets
 * Used by ProductController (scoped list + adjusted rate) and InvoiceController
 * (line validation + server-side rate).
 */
async function loadCatalog(companyId, customerId) {
    const catRows = await db('customer_user_categories')
        .where('company_id', companyId)
        .where('customer_id', customerId)
        .select('category_id', 'discount_pct', 'addition_pct');
    const categories = new Map();
    for (const r of catRows) {
        categories.set(Number(r.category_id), {
            discount_pct: Number(r.discount_pct) || 0,
            addition_pct: Number(r.addition_pct) || 0,
        });
    }

    const prodRows = await db('customer_user_products')
        .where('company_id', companyId)
        .where('customer_id', customerId)
        .select('category_id', 'product_id');
    const productsByCategory = new Map();
    for (const r of prodRows) {
        const key = Number(r.category_id);
        if (!productsByCategory.has(key)) productsByCategory.set(key, new Set());
        productsByCategory.get(key).add(Number(r.product_id));
    }

    return { categories, productsByCategory };
}

/**
 * Is this product allowed for the catalog, and at what rate? Returns
 * { allowed: boolean, rate: number|null }. `product` needs
 * { id, category_id, sales_price }.
 */
function priceProduct(catalog, product) {
    const catId = product.category_id != null ? Number(product.category_id) : null;
    if (catId == null || !catalog.categories.has(catId)) return { allowed: false, rate: null };
    const narrowed = catalog.productsByCategory.get(catId);
    if (narrowed && narrowed.size && !narrowed.has(Number(product.id))) {
        return { allowed: false, rate: null };
    }
    const { discount_pct, addition_pct } = catalog.categories.get(catId);
    return { allowed: true, rate: effectiveRate(product.sales_price, discount_pct, addition_pct) };
}

/**
 * POST /api/v1/customers/:id/login
 *
 * Make this customer a LOGIN USER — identical contract to the sales-person
 * setLogin (create path requires password; update path patches role/status/
 * password; dual-plane write + seat reconcile; role-assignability policy).
 */
async function setLogin(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const cust = await fetchCustomer(req.companyId, id);
        if (!cust) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const { email, password, role_id } = req.body;
        const status = req.body.status; // optional

        // Role-assignability (same policy as UserController.create / sales-person
        // setLogin): a tenant may assign a global SYSTEM role EXCEPT the
        // platform/admin roles, or one of THEIR OWN license's custom roles.
        const isSuper = req.user && req.user.role_slug === 'super-admin';
        const licenseId = (req.user && req.user.license_id) || null;
        const role = await db('roles').where('id', role_id)
            .first('id', 'slug', 'is_system', 'license_id');
        if (!role) return R.errorResponse(res, 'You cannot assign that role.', 422);
        if (!isSuper) {
            const assignable = !['super-admin', 'company-admin'].includes(role.slug)
                && ((role.is_system && role.license_id == null) || role.license_id === licenseId);
            if (!assignable) {
                return R.errorResponse(res, 'You cannot assign that role.', 422);
            }
        }
        const roleSlug = role.slug;

        // ── UPDATE path: the customer already has a linked login user. ──
        if (cust.user_id) {
            const linked = await db('users')
                .where('id', cust.user_id)
                .whereNull('deleted_at')
                .first('id', 'email', 'role_id', 'status');
            if (!linked) {
                cust.user_id = null; // dangling link → treat as create below
            } else {
                if (email && email !== linked.email) {
                    const clash = await emailTakenAcrossPlanes(email, licenseId, {
                        exceptUserId: linked.id,
                    });
                    if (clash) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);
                }

                const patch = { role_id, updated_at: new Date() };
                if (email) patch.email = email;
                if (status) patch.status = status;
                if (password) patch.password_hash = await hash(password);

                const freshStatus = await patchLicensedUser(
                    linked.id, licenseId, () => patch, { reconcile: !!status },
                );

                return R.successResponse(res, {
                    id:      linked.id,
                    email:   patch.email || linked.email,
                    role_id,
                    status:  freshStatus != null ? freshStatus : (patch.status || linked.status),
                }, 'Login updated.');
            }
        }

        // ── CREATE path: no linked user yet (or the link was dangling). ──
        if (!password) {
            return R.errorResponse(res, 'Password is required to create a login.', 422);
        }

        const taken = await emailTakenAcrossPlanes(email, licenseId, {});
        if (taken) return R.errorResponse(res, EMAIL_TAKEN_MSG, 422);

        const password_hash = await hash(password);
        const now = new Date();
        const row = {
            company_id:      req.companyId,
            license_id:      licenseId,
            role_id,
            name:            cust.name,
            email,
            mobile:          cust.mobile || null,
            password_hash,
            status:          status || 'Active',
            // NULL — the customer login is scoped by their catalog assignment,
            // not by the single-location user scope.
            location_id:     null,
            approval_status: 'approved',
            approved_at:     now,
            approved_by:     req.user ? req.user.sub : null,
        };

        const linked = await createLicensedUser(row, roleSlug, ['id', 'email', 'role_id', 'status']);
        await db('customers').where('id', cust.id)
            .update({ user_id: linked.id, updated_at: new Date() });

        const msg = linked.status === 'Active'
            ? 'Login created. The customer can sign in now.'
            : 'Login created but inactive — the license seat limit is reached. Raise the plan (max_users) to activate them.';
        return R.successResponse(res, {
            id:      linked.id,
            email:   linked.email,
            role_id: linked.role_id,
            status:  linked.status,
        }, msg);
    } catch (err) {
        console.error('customers.setLogin error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * PUT /api/v1/customers/:id/catalog
 *
 * Replace the customer's catalog assignment. Body validated by catalogSchema
 * { categories: [{ category_id, discount_pct, addition_pct, product_ids? }] }.
 * Category/product ids are filtered to the caller's company (foreign ids are
 * silently dropped, never assigned); product_ids must belong to their category.
 * Transactional delete-all-then-insert, per the sales-person assignment pattern.
 */
async function setCatalog(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const cust = await fetchCustomer(req.companyId, id);
        if (!cust) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const entries = req.body.categories || [];

        // De-dup by category_id (last entry wins) before validating ids.
        const byCat = new Map();
        for (const e of entries) byCat.set(Number(e.category_id), e);

        // Keep only categories that belong to this company (non-deleted).
        let validCatIds = [];
        if (byCat.size) {
            const rows = await db('categories')
                .where('company_id', req.companyId)
                .whereNull('deleted_at')
                .whereIn('id', Array.from(byCat.keys()))
                .select('id');
            validCatIds = rows.map((r) => Number(r.id));
        }

        // Validate each entry's product narrowing against the category.
        const catRows = [];
        const prodRows = [];
        const now = new Date();
        for (const catId of validCatIds) {
            const e = byCat.get(catId);
            catRows.push({
                company_id:   req.companyId,
                customer_id:  cust.id,
                category_id:  catId,
                discount_pct: e.discount_pct || 0,
                addition_pct: e.addition_pct || 0,
                created_at:   now,
                updated_at:   now,
            });

            const requested = Array.from(new Set(e.product_ids || []));
            if (requested.length) {
                const prods = await db('products')
                    .where('company_id', req.companyId)
                    .where('category_id', catId)
                    .whereNull('deleted_at')
                    .whereIn('id', requested)
                    .select('id');
                for (const p of prods) {
                    prodRows.push({
                        company_id:  req.companyId,
                        customer_id: cust.id,
                        category_id: catId,
                        product_id:  Number(p.id),
                        created_at:  now,
                        updated_at:  now,
                    });
                }
            }
        }

        await db.transaction(async (trx) => {
            await trx('customer_user_categories')
                .where('company_id', req.companyId)
                .where('customer_id', cust.id)
                .del();
            await trx('customer_user_products')
                .where('company_id', req.companyId)
                .where('customer_id', cust.id)
                .del();
            if (catRows.length)  await trx('customer_user_categories').insert(catRows);
            if (prodRows.length) await trx('customer_user_products').insert(prodRows);
        });

        return R.successResponse(res, {
            categories: catRows.map((r) => ({
                category_id:  r.category_id,
                discount_pct: r.discount_pct,
                addition_pct: r.addition_pct,
                product_ids:  prodRows.filter((p) => p.category_id === r.category_id)
                    .map((p) => p.product_id),
            })),
        }, 'Catalog updated.');
    } catch (err) {
        console.error('customers.setCatalog error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /api/v1/customers/:id/assignments
 *
 * Prefill payload for the edit form:
 *   { user: { id, email, role_id, status } | null,
 *     categories: [{ category_id, discount_pct, addition_pct, product_ids: [] }] }
 */
async function getAssignments(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);

    try {
        const cust = await fetchCustomer(req.companyId, id);
        if (!cust) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const catRows = await db('customer_user_categories')
            .where('company_id', req.companyId)
            .where('customer_id', cust.id)
            .select('category_id', 'discount_pct', 'addition_pct');
        const prodRows = await db('customer_user_products')
            .where('company_id', req.companyId)
            .where('customer_id', cust.id)
            .select('category_id', 'product_id');

        const categories = catRows.map((c) => ({
            category_id:  Number(c.category_id),
            discount_pct: Number(c.discount_pct) || 0,
            addition_pct: Number(c.addition_pct) || 0,
            product_ids:  prodRows.filter((p) => Number(p.category_id) === Number(c.category_id))
                .map((p) => Number(p.product_id)),
        }));

        let user = null;
        if (cust.user_id) {
            const u = await db('users')
                .where('id', cust.user_id)
                .whereNull('deleted_at')
                .first('id', 'email', 'role_id', 'status');
            if (u) user = { id: u.id, email: u.email, role_id: u.role_id, status: u.status };
        }

        return R.successResponse(res, { user, categories });
    } catch (err) {
        console.error('customers.getAssignments error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    setLogin,
    setCatalog,
    getAssignments,
    // Shared helpers for Product/Invoice scoping:
    loadCatalog,
    priceProduct,
    effectiveRate,
};
