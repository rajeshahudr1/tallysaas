'use strict';

/* ─────────────────────────────────────────────────────────────
 * routes/web.js — the 3 page routes for the Phase-1 UI.
 *
 * This Router is the ONLY place that reads data/mock.js. Each handler
 * pulls exactly what its view needs and passes it as render locals.
 * Header/identity locals (user, company, companies, notificationCount)
 * are injected globally in index.js, so handlers only add the
 * page-specific locals (title, activeMenu, breadcrumb, data).
 *
 * SWAP TO API LATER: make a handler `async` and replace the `mock.*`
 * reads with `await apiClient.*` calls. The render local NAMES stay the
 * same, so the EJS views/partials never change.
 * ─────────────────────────────────────────────────────────── */

const express = require('express');
const router  = express.Router();
const mock    = require('../data/mock');
const api     = require('../Helpers/apiClient');
const { requireAuth } = require('../Middlewares/sessionGuard');
const AuthController   = require('../Controllers/AuthController');

/* ── Public auth routes (NO guard) ──────────────────────────── */
router.get('/login',  AuthController.showLogin);
router.post('/login', AuthController.login);
router.get('/logout', AuthController.logout);

/* Everything below this line requires a logged-in session. */
router.use(requireAuth);

/* ── Company switcher (GET /switch-company/:id) ─────────────────
 * Sets the active company on the session (only if it is one the user may
 * access — the list was license-scoped at login), then returns to the
 * page they were on. apiClient then sends the new X-Company-Id, so every
 * subsequent page shows that company's data. */
router.get('/switch-company/:id', (req, res) => {
    const id = Number(req.params.id);
    const companies = (req.session && Array.isArray(req.session.companies)) ? req.session.companies : [];
    const match = companies.find((c) => Number(c.id) === id);
    const back = req.get('Referer') || '/';
    if (match) {
        req.session.companyId   = id;
        req.session.companyName = match.name;
        if (req.session) req.session.flash = { type: 'success', msg: `Switched to ${match.name}.` };
    } else if (req.session) {
        req.session.flash = { type: 'error', msg: 'You do not have access to that company.' };
    }
    return req.session.save(() => res.redirect(back));
});

/* Format an ISO/Date string to dd/mm/yyyy for the table views. */
function fmtDate(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/* Generic list fetch: forwards page/per_page/search/status query params to
 * the api and returns { rows, meta }. Each page maps `rows` to its view's
 * expected field names before rendering. */
async function apiList(req, basePath) {
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = parseInt(req.query.per_page, 10) || 10;
    const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (req.query.search) qs.set('search', String(req.query.search));
    if (req.query.status) qs.set('status', String(req.query.status));
    if (req.query.sort)   qs.set('sort',  String(req.query.sort));
    if (req.query.order)  qs.set('order', String(req.query.order));

    const { body } = await api.get(req, `${basePath}?${qs.toString()}`);
    const payload  = (body && body.data) || {};
    const rows     = Array.isArray(payload.data) ? payload.data : [];
    const meta     = payload.meta || { total: rows.length, page, per_page: perPage };
    return { rows, meta };
}

/* Fetch a master list as id+name options for FK <select>s in Add forms.
 * per_page=100 = the api list validators' max page size. */
async function fetchOptions(req, basePath) {
    const { body } = await api.get(req, `${basePath}?per_page=100`);
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => ({ id: r.id, name: r.name }));
}

/* Products as line-item picker options (id + the data the invoice.js
 * engine reads). `priceField` = 'sales_price' (sales) or 'purchase_price'. */
async function fetchInvoiceProducts(req, priceField) {
    const { body } = await api.get(req, '/products?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((p) => ({
        id: p.id, name: p.name, hsn: p.hsn_code || '', unit: p.unit || '',
        rate: p[priceField] != null ? parseFloat(p[priceField]) : 0,
        gst:  p.gst_rate != null ? parseFloat(p.gst_rate) : 0,
    }));
}

/* Parse the hidden items_json from an invoice form into the api's item
 * shape (drops malformed/empty rows; the api re-computes all totals). */
function parseInvoiceItems(raw) {
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.map((it) => ({
        product_id:   it.product_id ? Number(it.product_id) : undefined,
        description:  it.description || undefined,
        hsn:          it.hsn || undefined,
        quantity:     Number(it.quantity) || 0,
        unit:         it.unit || undefined,
        rate:         Number(it.rate) || 0,
        discount_pct: Number(it.discount_pct) || 0,
        gst_rate:     Number(it.gst_rate) || 0,
    })).filter((it) => it.quantity > 0);
}

/* One-shot flash (read + cleared by the res.locals middleware in index.js). */
function setFlash(req, type, msg) {
    if (req.session) req.session.flash = { type, msg };
}

/* Pull a clean error message out of an api envelope / transport result. */
function apiError(result, fallback) {
    if (result && result.networkError) return 'Cannot reach the API server.';
    if (result && result.body && result.body.msg) return result.body.msg;
    return fallback || 'Something went wrong.';
}

/* True when the api envelope is a success (HTTP 200 + body.status 200). */
function apiOk(result) {
    return result && result.body && result.body.status === 200;
}

/* Checkbox → boolean (an unchecked box sends nothing). */
function asBool(v) { return v !== undefined && v !== null && v !== '' && v !== 'false' && v !== '0'; }

/* api transaction status code → human display label (the table's status
 * pill colours work off either, but this keeps the text clean). */
function txStatusLabel(s) {
    const map = {
        pending_tally: 'Pending Tally', sent_to_tally: 'Sent to Tally',
        created: 'Created', failed: 'Failed',
    };
    return map[String(s || '').toLowerCase()] || s || '';
}

/* ── PAGE 3 — Dashboard (GET /) ─────────────────────────────── */
router.get('/', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/dashboard/summary');
        const data = (body && body.data) || {};

        const counts = data.counts || {};
        const sc = data.sales_chart || {};
        const syc = data.sync_chart || {};
        const recInv = Array.isArray(data.recent_invoices) ? data.recent_invoices : [];
        const recSync = Array.isArray(data.recent_sync) ? data.recent_sync : [];

        // Number helpers: Indian-grouped integers for display strings, so
        // the API numbers render exactly like the pre-formatted mock values.
        const num = (v) => Number(v || 0);
        const grp = (v) => num(v).toLocaleString('en-IN');
        const inr = (v) => '₹' + grp(v);

        // counts → the 8 stat cards. label/icon/tone copied verbatim from
        // mock.dashboardStats so the cards look identical (labels also drive
        // the view's per-card sparkline/trend lookup, so they MUST match).
        const stats = [
            { label: 'Total Companies',    value: grp(counts.companies),        icon: 'fa-building',          tone: 'blue'   },
            { label: 'Total Customers',    value: grp(counts.customers),        icon: 'fa-user-group',        tone: 'purple' },
            { label: 'Total Products',     value: grp(counts.products),         icon: 'fa-box',               tone: 'teal'   },
            { label: "Today's Sales",      value: inr(counts.today_sales),      icon: 'fa-indian-rupee-sign', tone: 'green'  },
            { label: 'Pending Tally Sync', value: grp(counts.pending_sync),     icon: 'fa-rotate',            tone: 'amber'  },
            { label: 'Stock Value',        value: inr(counts.stock_value),      icon: 'fa-warehouse',         tone: 'indigo' },
            { label: 'Invoice Amount',     value: inr(counts.invoice_amount),   icon: 'fa-file-invoice',      tone: 'blue'   },
            { label: 'Payment Received',   value: inr(counts.payment_received), icon: 'fa-money-bill-wave',   tone: 'green'  },
        ];

        // Chart payloads — pass through as {labels,data}, defaulting to empty
        // arrays so /js/dashboard.js + the JSON island never see undefined.
        const salesChart = {
            labels: Array.isArray(sc.labels) ? sc.labels : [],
            data:   Array.isArray(sc.data)   ? sc.data   : [],
        };
        const syncChart = {
            labels: Array.isArray(syc.labels) ? syc.labels : [],
            data:   Array.isArray(syc.data)   ? syc.data   : [],
        };

        // recent_invoices → the Table component rows. `amount` stays a raw
        // number (the table's currency type formats it); status code →
        // human label (Created/Pending Tally/Failed) which the pill maps.
        const recentInvoices = recInv.map((r) => ({
            invoice:  r.invoice_no || '',
            customer: r.customer || '',
            amount:   num(r.total),
            status:   txStatusLabel(r.status),
            date:     fmtDate(r.invoice_date),
        }));

        // recent_sync → the compact activity list. Title-case the status so
        // both the visible pill text and _syncPillClass (Synced/Pending/
        // Failed) resolve correctly. Prefer record_type+record_id for the
        // record line, falling back to either alone.
        const titleCase = (v) => {
            const s = String(v || '');
            return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
        };
        const recentSync = recSync.map((r) => ({
            module: r.module || '',
            record: [r.record_type, r.record_id].filter(Boolean).join(' ') || r.record_id || r.record_type || '',
            status: titleCase(r.status),
            time:   fmtDate(r.created_at),
        }));

        res.render('dashboard/index', {
            title: 'Dashboard',
            activeMenu: 'dashboard',
            breadcrumb: [{ label: 'Dashboard' }],

            // Page data (now API-driven).
            stats,
            salesChart,
            syncChart,
            recentInvoices,
            recentSync,

            // Chart.js init for THIS page only. Passed as a real render local
            // (NOT assigned inside the template) so it reaches the layout's
            // `pageScript` slot, which sits AFTER the Chart.js CDN tag in
            // _layout.ejs — guaranteeing Chart is defined before this runs.
            pageScript: '<script src="/js/dashboard.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Companies listing (GET /companies) — REAL API ──── */
router.get('/companies', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/companies');
        const companyRows = rows.map((r) => ({
            id: r.id, name: r.name, gst: r.gst_number || '', pan: r.pan_number || '',
            mobile: r.mobile || '', email: r.email || '', financial_year: r.financial_year || '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('companies/list', {
            title: 'Companies',
            activeMenu: 'companies',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Companies' }],
            // NOTE: `companyRows` (NOT `companies`) — `companies` is the global
            // header-switcher list; reusing it here would corrupt that dropdown.
            companyRows, companiesTotal: meta.total, page: meta.page, perPage: meta.per_page,
            financialYears: mock.financialYears,
        });
    } catch (err) { next(err); }
});

/* ── POST /companies — register a company under the caller's license ──
 * On success we refresh the session's switchable-companies list so the new
 * company is immediately available in the header switcher. */
router.post('/companies', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, mobile: b.mobile || undefined, email: b.email || undefined,
            gst_number: b.gst_number || undefined, pan_number: b.pan_number || undefined,
            financial_year: b.financial_year || undefined, address: b.address || undefined,
            status: b.status || 'Active',
        };
        const result = await api.post(req, '/companies', payload);
        if (apiOk(result)) {
            // Refresh the switcher list (best-effort).
            try {
                const mc = await api.get(req, '/my-companies');
                if (mc.body && mc.body.data && Array.isArray(mc.body.data.data)) {
                    req.session.companies = mc.body.data.data.map((c) => ({ id: c.id, name: c.name }));
                }
            } catch (_) { /* non-fatal */ }
            setFlash(req, 'success', 'Company registered successfully.');
            return req.session.save(() => res.redirect('/companies'));
        }
        setFlash(req, 'error', apiError(result, 'Could not register the company.'));
        return req.session.save(() => res.redirect('/companies/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Company (GET /companies/add) ─────────────── */
router.get('/companies/add', (req, res) => {
    res.render('companies/form', {
        title: 'Add Company',
        activeMenu: 'companies',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Companies', href: '/companies' },
            { label: 'Add Company' },
        ],

        // Form dropdown option sources.
        financialYears: mock.financialYears,
    });
});

/* ── MASTERS · Locations listing (GET /locations) ───────────── */
router.get('/locations', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/locations');
        const locationRows = rows.map((r) => ({
            id: r.id, name: r.name, code: r.code, city: r.city, state: r.state,
            mobile: r.mobile, manager: r.manager, customers: r.customers || '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('locations/list', {
            title: 'Locations',
            activeMenu: 'locations',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Locations' }],
            locationRows, locationsTotal: meta.total, page: meta.page, perPage: meta.per_page,
            states: mock.states,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Location (GET /locations/add) ────────────── */
router.get('/locations/add', (req, res) => {
    res.render('locations/form', {
        title: 'Add Location',
        activeMenu: 'locations',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Locations', href: '/locations' },
            { label: 'Add Location' },
        ],

        // Form option sources.
        states:       mock.states,
        salesPersons: mock.salesPersons,
    });
});

/* ── POST /locations — create via api (no FK; state/manager are text) ── */
router.post('/locations', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, code: b.code || undefined, city: b.city || undefined,
            state: b.state || undefined, pincode: b.pincode || undefined,
            mobile: b.mobile || undefined, manager: b.manager || undefined,
            status: b.status || 'Active', is_tally_godown: asBool(b.is_tally_godown),
        };
        const result = await api.post(req, '/locations', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Location created successfully.'); return req.session.save(() => res.redirect('/locations')); }
        setFlash(req, 'error', apiError(result, 'Could not create location.'));
        return req.session.save(() => res.redirect('/locations/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Sales Persons listing (GET /sales-persons) ───── */
router.get('/sales-persons', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/sales-persons');
        const salesPersonRows = rows.map((r) => ({
            id: r.id, name: r.name, employee_code: r.employee_code, mobile: r.mobile,
            email: r.email, locations: [], customers: r.customers || '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('sales-persons/list', {
            title: 'Sales Persons',
            activeMenu: 'sales',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Sales Persons' }],
            salesPersonRows, salesPersonsTotal: meta.total, page: meta.page, perPage: meta.per_page,
            locationNames: mock.locationNames,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Sales Person (GET /sales-persons/add) ────── */
router.get('/sales-persons/add', (req, res) => {
    res.render('sales-persons/form', {
        title: 'Add Sales Person',
        activeMenu: 'sales',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Persons', href: '/sales-persons' },
            { label: 'Add Sales Person' },
        ],

        // Full location list for the "Assigned Locations" mapping pane.
        locationOptions: mock.locationsList,
    });
});

/* ── POST /sales-persons — create via api (base fields; the
 * Assigned-Locations mapping is a separate endpoint, not yet wired) ── */
router.post('/sales-persons', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, employee_code: b.employee_code || undefined,
            mobile: b.mobile || undefined, email: b.email || undefined,
            joining_date: b.joining_date || undefined, status: b.status || 'Active',
        };
        const result = await api.post(req, '/sales-persons', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Sales person created successfully.'); return req.session.save(() => res.redirect('/sales-persons')); }
        setFlash(req, 'error', apiError(result, 'Could not create sales person.'));
        return req.session.save(() => res.redirect('/sales-persons/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Suppliers listing (GET /suppliers) ───────────── */
router.get('/suppliers', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/suppliers');
        const supplierRows = rows.map((r) => ({
            id: r.id, name: r.name, location: r.location || '', mobile: r.mobile,
            gst: r.gst_number || '', group: r.supplier_group || '',
            opening_balance: r.opening_balance, payment_terms: r.payment_terms || '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('suppliers/list', {
            title: 'Suppliers',
            activeMenu: 'suppliers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Suppliers' }],
            supplierRows, suppliersTotal: meta.total, page: meta.page, perPage: meta.per_page,
            locationNames: mock.locationNames, supplierGroups: mock.supplierGroups,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Supplier (GET /suppliers/add) ────────────── */
router.get('/suppliers/add', async (req, res, next) => {
    try {
        const locationOptions = await fetchOptions(req, '/locations');
        res.render('suppliers/form', {
            title: 'Add Supplier',
            activeMenu: 'suppliers',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Suppliers', href: '/suppliers' },
                { label: 'Add Supplier' },
            ],
            locationOptions,                 // FK (id+name) for the Location select
            supplierGroups: mock.supplierGroups,
            paymentTerms:   mock.paymentTerms,
        });
    } catch (err) { next(err); }
});

/* ── POST /suppliers — create via api ───────────────────────── */
router.post('/suppliers', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            name: b.name, mobile: b.mobile || undefined, alternate_mobile: b.alternate_mobile || undefined,
            email: b.email || undefined, gst_number: b.gst_number || undefined,
            supplier_group: b.supplier_group || undefined, location_id: num(b.location_id),
            opening_balance: num(b.opening_balance), payment_terms: b.payment_terms || undefined,
            status: b.status || 'Active', is_tally_ledger: asBool(b.is_tally_ledger),
        };
        const result = await api.post(req, '/suppliers', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Supplier created successfully.'); return req.session.save(() => res.redirect('/suppliers')); }
        setFlash(req, 'error', apiError(result, 'Could not create supplier.'));
        return req.session.save(() => res.redirect('/suppliers/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Products listing (GET /products) ─────────────── */
router.get('/products', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/products');
        const productRows = rows.map((r) => ({
            id: r.id, name: r.name, sku: r.sku || '', category: r.category || '',
            hsn: r.hsn_code || '', gst_rate: (r.gst_rate != null ? parseFloat(r.gst_rate) + '%' : ''),
            purchase_price: r.purchase_price, sales_price: r.sales_price,
            stock: r.opening_stock != null ? parseFloat(r.opening_stock) : '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('products/list', {
            title: 'Products',
            activeMenu: 'products',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Products' }],
            productRows, productsTotal: meta.total, page: meta.page, perPage: meta.per_page,
            categoryNames: mock.categoryNames, gstRates: mock.gstRates,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Product (GET /products/add) ──────────────── */
router.get('/products/add', async (req, res, next) => {
    try {
        const categoryOptions = await fetchOptions(req, '/categories');
        res.render('products/form', {
            title: 'Add Product',
            activeMenu: 'products',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Products', href: '/products' },
                { label: 'Add Product' },
            ],
            categoryOptions,                 // FK (id+name) for the Category select
            units:    mock.units,
            gstRates: mock.gstRates,
        });
    } catch (err) { next(err); }
});

/* ── POST /products — create via api ────────────────────────── */
router.post('/products', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            name: b.name, sku: b.sku || undefined, category_id: num(b.category_id),
            unit: b.unit || undefined, hsn_code: b.hsn_code || undefined,
            gst_rate: b.gst_rate ? parseFloat(String(b.gst_rate)) : undefined,   // "18%" → 18
            purchase_price: num(b.purchase_price), sales_price: num(b.sales_price),
            opening_stock: num(b.opening_stock), status: b.status || 'Active',
            is_tally_item: asBool(b.is_tally_item), description: b.description || undefined,
        };
        const result = await api.post(req, '/products', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Product created successfully.'); return req.session.save(() => res.redirect('/products')); }
        setFlash(req, 'error', apiError(result, 'Could not create product.'));
        return req.session.save(() => res.redirect('/products/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Categories listing (GET /categories) ─────────── */
router.get('/categories', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/categories');
        const categoryRows = rows.map((r) => ({
            id: r.id, name: r.name, parent: r.parent || '—', products: r.products || '',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('categories/list', {
            title: 'Categories',
            activeMenu: 'categories',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Categories' }],
            categoryRows, categoriesTotal: meta.total, page: meta.page, perPage: meta.per_page,
            categoryNames: mock.categoryNames,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Category (GET /categories/add) ───────────── */
router.get('/categories/add', async (req, res, next) => {
    try {
        const parentOptions = await fetchOptions(req, '/categories');
        res.render('categories/form', {
            title: 'Add Category',
            activeMenu: 'categories',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Categories', href: '/categories' },
                { label: 'Add Category' },
            ],
            parentOptions,                   // FK (id+name) for the Parent select
        });
    } catch (err) { next(err); }
});

/* ── POST /categories — create via api ──────────────────────── */
router.post('/categories', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name,
            parent_id: (b.parent_id === '' || b.parent_id == null) ? undefined : Number(b.parent_id),
            status: b.status || 'Active',
        };
        const result = await api.post(req, '/categories', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Category created successfully.'); return req.session.save(() => res.redirect('/categories')); }
        setFlash(req, 'error', apiError(result, 'Could not create category.'));
        return req.session.save(() => res.redirect('/categories/add'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Sales Invoices listing (GET /sales-invoices) */
router.get('/sales-invoices', async (req, res, next) => {
  try {
    const { rows, meta } = await apiList(req, '/sales-invoices');
    const invoiceRows = rows.map((r) => ({
        id: r.id, invoice_no: r.invoice_no, date: fmtDate(r.invoice_date),
        customer: r.customer || '', location: r.location || '',
        amount: r.taxable, gst: r.tax_amount, total: r.total,
        status: txStatusLabel(r.status), sales_person: r.sales_person || '',
    }));
    res.render('sales-invoices/list', {
        title: 'Sales Invoices',
        activeMenu: 'sales-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Invoices' },
        ],

        invoiceRows,
        invoicesTotal:  meta.total,
        page:           meta.page,
        perPage:        meta.per_page,

        // Filter option sources.
        customerNames:  mock.customerNames,
        locationNames:  mock.locationNames,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Create Sales Invoice (GET /sales-invoices/create) */
router.get('/sales-invoices/create', async (req, res, next) => {
  try {
    const [customerOptions, locationOptions, salesPersonOptions, invoiceProducts] = await Promise.all([
        fetchOptions(req, '/customers'),
        fetchOptions(req, '/locations'),
        fetchOptions(req, '/sales-persons'),
        fetchInvoiceProducts(req, 'sales_price'),
    ]);
    res.render('sales-invoices/create', {
        title: 'Create Invoice',
        activeMenu: 'sales-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Invoices', href: '/sales-invoices' },
            { label: 'Create Invoice' },
        ],

        customerOptions, locationOptions, salesPersonOptions, invoiceProducts,
        nextInvoiceNo: 'Auto-generated on save',

        // Inject the line-item calculator only on this page.
        pageScript: '<script src="/js/invoice.js" defer></script>',
    });
  } catch (err) { next(err); }
});

/* ── POST /sales-invoices — create a sales invoice via the api ──
 * Header fields submit normally; line items ride the hidden items_json
 * (serialised by /js/invoice.js). The api computes all totals + the
 * invoice number inside a db transaction. */
router.post('/sales-invoices', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            customer_id:     num(b.customer_id),
            location_id:     num(b.location_id),
            sales_person_id: num(b.sales_person_id),
            invoice_date:    b.invoice_date || undefined,
            due_date:        b.due_date || undefined,
            notes:           b.notes || undefined,
            items:           parseInvoiceItems(b.items_json),
        };
        const result = await api.post(req, '/sales-invoices', payload);
        if (apiOk(result)) {
            const no = result.body.data && result.body.data.invoice_no;
            setFlash(req, 'success', `Invoice ${no || ''} created successfully.`);
            return req.session.save(() => res.redirect('/sales-invoices'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create invoice.'));
        return req.session.save(() => res.redirect('/sales-invoices/create'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Purchase Invoices (GET /purchase-invoices) ─ */
router.get('/purchase-invoices', async (req, res, next) => {
  try {
    const { rows, meta } = await apiList(req, '/purchase-invoices');
    const purchaseRows = rows.map((r) => ({
        id: r.id, bill_no: r.invoice_no, date: fmtDate(r.invoice_date),
        supplier: r.supplier || '', location: r.location || '',
        amount: r.taxable, gst: r.tax_amount, total: r.total,
        status: txStatusLabel(r.status),
    }));
    res.render('purchase-invoices/list', {
        title: 'Purchase Invoices',
        activeMenu: 'purchase-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Purchase Invoices' },
        ],

        purchaseRows,
        purchasesTotal:  meta.total,
        page:            meta.page,
        perPage:         meta.per_page,

        supplierNames:   mock.supplierNames,
        locationNames:   mock.locationNames,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Create Purchase (GET /purchase-invoices/create) */
router.get('/purchase-invoices/create', async (req, res, next) => {
  try {
    const [supplierOptions, locationOptions, invoiceProducts] = await Promise.all([
        fetchOptions(req, '/suppliers'),
        fetchOptions(req, '/locations'),
        fetchInvoiceProducts(req, 'purchase_price'),   // priced at purchase price
    ]);
    res.render('purchase-invoices/create', {
        title: 'Create Purchase',
        activeMenu: 'purchase-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Purchase Invoices', href: '/purchase-invoices' },
            { label: 'Create Purchase' },
        ],

        supplierOptions, locationOptions, invoiceProducts,
        nextBillNo: 'Auto-generated on save',

        // Reuse the SAME line-item engine as sales invoices.
        pageScript: '<script src="/js/invoice.js" defer></script>',
    });
  } catch (err) { next(err); }
});

/* ── POST /purchase-invoices — create a purchase invoice via api ──
 * Same shape as sales; the form's date field is `bill_date` → mapped to
 * the api's `invoice_date`. */
router.post('/purchase-invoices', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            supplier_id:      num(b.supplier_id),
            location_id:      num(b.location_id),
            supplier_bill_no: b.supplier_bill_no || undefined,
            invoice_date:     b.bill_date || b.invoice_date || undefined,
            due_date:         b.due_date || undefined,
            notes:            b.notes || undefined,
            items:            parseInvoiceItems(b.items_json),
        };
        const result = await api.post(req, '/purchase-invoices', payload);
        if (apiOk(result)) {
            const no = result.body.data && result.body.data.invoice_no;
            setFlash(req, 'success', `Purchase ${no || ''} created successfully.`);
            return req.session.save(() => res.redirect('/purchase-invoices'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create purchase.'));
        return req.session.save(() => res.redirect('/purchase-invoices/create'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Payments listing (GET /payments) ────────── */
router.get('/payments', async (req, res, next) => {
  try {
    const { rows, meta } = await apiList(req, '/payments');
    const paymentRows = rows.map((r) => ({
        id: r.id, payment_no: r.voucher_no, date: fmtDate(r.payment_date),
        party: r.party || '', mode: r.mode || '', reference: r.reference || '—',
        amount: r.amount, status: txStatusLabel(r.status),
    }));
    res.render('payments/list', {
        title: 'Payments',
        activeMenu: 'payments',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Payments' },
        ],

        paymentRows,
        paymentsTotal:   meta.total,
        page:            meta.page,
        perPage:         meta.per_page,

        supplierNames:   mock.supplierNames,
        paymentModes:    mock.paymentModes,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Add Payment (GET /payments/add) ─────────── */
router.get('/payments/add', async (req, res, next) => {
    try {
        const supplierOptions = await fetchOptions(req, '/suppliers');
        res.render('payments/form', {
            title: 'Add Payment',
            activeMenu: 'payments',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Payments', href: '/payments' },
                { label: 'Add Payment' },
            ],
            supplierOptions,                 // FK (id+name) for the Supplier select
            paymentModes:  mock.paymentModes,
            nextPaymentNo: mock.nextPaymentNo,
        });
    } catch (err) { next(err); }
});

/* ── POST /payments — create payment voucher via api ────────── */
router.post('/payments', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            supplier_id: (b.supplier_id === '' || b.supplier_id == null) ? undefined : Number(b.supplier_id),
            payment_date: b.payment_date || undefined, mode: b.mode || undefined,
            amount: (b.amount === '' || b.amount == null) ? undefined : Number(b.amount),
            reference: b.reference || undefined, bank_account: b.bank_account || undefined,
            notes: b.notes || undefined, status: b.status || 'pending_tally',
        };
        const result = await api.post(req, '/payments', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Payment voucher created successfully.'); return req.session.save(() => res.redirect('/payments')); }
        setFlash(req, 'error', apiError(result, 'Could not create payment.'));
        return req.session.save(() => res.redirect('/payments/add'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Receipts listing (GET /receipts) ────────── */
router.get('/receipts', async (req, res, next) => {
  try {
    const { rows, meta } = await apiList(req, '/receipts');
    const receiptRows = rows.map((r) => ({
        id: r.id, receipt_no: r.voucher_no, date: fmtDate(r.payment_date),
        party: r.party || '', mode: r.mode || '', reference: r.reference || '—',
        amount: r.amount, status: txStatusLabel(r.status),
    }));
    res.render('receipts/list', {
        title: 'Receipts',
        activeMenu: 'receipts',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Receipts' },
        ],

        receiptRows,
        receiptsTotal:   meta.total,
        page:            meta.page,
        perPage:         meta.per_page,

        customerNames:   mock.customerNames,
        paymentModes:    mock.paymentModes,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Add Receipt (GET /receipts/add) ─────────── */
router.get('/receipts/add', async (req, res, next) => {
    try {
        const customerOptions = await fetchOptions(req, '/customers');
        res.render('receipts/form', {
            title: 'Add Receipt',
            activeMenu: 'receipts',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Receipts', href: '/receipts' },
                { label: 'Add Receipt' },
            ],
            customerOptions,                 // FK (id+name) for the Customer select
            paymentModes:  mock.paymentModes,
            nextReceiptNo: mock.nextReceiptNo,
        });
    } catch (err) { next(err); }
});

/* ── POST /receipts — create receipt voucher via api ────────────
 * The receipt form's date field is `receipt_date`; the api uses
 * `payment_date` (shared with payments), so we remap it here. */
router.post('/receipts', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            customer_id: (b.customer_id === '' || b.customer_id == null) ? undefined : Number(b.customer_id),
            payment_date: b.receipt_date || b.payment_date || undefined, mode: b.mode || undefined,
            amount: (b.amount === '' || b.amount == null) ? undefined : Number(b.amount),
            reference: b.reference || undefined, bank_account: b.bank_account || undefined,
            notes: b.notes || undefined, status: b.status || 'pending_tally',
        };
        const result = await api.post(req, '/receipts', payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Receipt voucher created successfully.'); return req.session.save(() => res.redirect('/receipts')); }
        setFlash(req, 'error', apiError(result, 'Could not create receipt.'));
        return req.session.save(() => res.redirect('/receipts/add'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Inventory / Stock (GET /inventory) ──────── */
router.get('/inventory', async (req, res, next) => {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = parseInt(req.query.per_page, 10) || 10;
        const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        if (req.query.search) qs.set('search', String(req.query.search));
        if (req.query.status) qs.set('status', String(req.query.status));

        const { body } = await api.get(req, `/inventory?${qs.toString()}`);
        const payload  = (body && body.data) || {};
        const rows     = Array.isArray(payload.data) ? payload.data : [];
        const meta     = payload.meta || { total: rows.length, page, per_page: perPage };
        const stats    = payload.stats || {};

        // Indian-grouped currency (e.g. 4820000 → ₹48,20,000) for the value
        // stat card; matches the pre-formatted mock string.
        const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN');

        // Map api rows → the view's expected table keys. No per-row location
        // from the api, so default to '' so the 'location' column never crashes.
        const stockRows = rows.map((r) => ({
            id:        r.id,
            product:   r.product || '',
            sku:       r.sku || '',
            location:  r.location || '',
            opening:   r.opening != null ? r.opening : 0,
            purchased: r.purchased != null ? r.purchased : 0,
            sold:      r.sold != null ? r.sold : 0,
            current:   r.current != null ? r.current : 0,
            value:     r.value != null ? r.value : 0,
            status:    r.status_label || '',
        }));

        // 4 summary cards — same {label,value,icon,tone} keys/icons/tones as
        // mock.inventoryStats; values come from the api `stats` block.
        const inventoryStats = [
            { label: 'Total Stock Value', value: inr(stats.stock_value),            icon: 'fa-warehouse',            tone: 'indigo' },
            { label: 'Total SKUs',        value: String(stats.total_skus || 0),     icon: 'fa-box',                  tone: 'blue'   },
            { label: 'Low Stock Items',   value: String(stats.low_stock || 0),      icon: 'fa-triangle-exclamation', tone: 'amber'  },
            { label: 'Out of Stock',      value: String(stats.out_of_stock || 0),   icon: 'fa-circle-xmark',         tone: 'teal'   },
        ];

        res.render('inventory/list', {
            title: 'Inventory',
            activeMenu: 'inventory',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Inventory' },
            ],

            stockRows,
            stockTotal: meta.total,
            page:       meta.page,
            perPage:    meta.per_page,

            inventoryStats,

            // Filter dropdown option sources (still mock for now).
            categoryNames: mock.categoryNames,
            locationNames: mock.locationNames,
            stockStatuses: mock.stockStatuses,
        });
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Stock Adjustment (GET /inventory/adjust) ──
 * FK selects (Product / Location) fetched from the api as {id,name} so the
 * form submits real ids. */
router.get('/inventory/adjust', async (req, res, next) => {
    try {
        const [productOptions, locationOptions] = await Promise.all([
            fetchOptions(req, '/products'),
            fetchOptions(req, '/locations'),
        ]);
        res.render('inventory/form', {
            title: 'Stock Adjustment',
            activeMenu: 'inventory',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Inventory', href: '/inventory' },
                { label: 'Stock Adjustment' },
            ],
            productOptions, locationOptions,
        });
    } catch (err) { next(err); }
});

/* ── POST /inventory/adjust — apply a stock adjustment via the api ── */
router.post('/inventory/adjust', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            product_id:  _num(b.product_id),
            location_id: _num(b.location_id),
            type:        b.adjustment_type || undefined,
            quantity:    _num(b.quantity),
            reason:      b.reason || undefined,
            notes:       b.notes || undefined,
            date:        b.date || undefined,
        };
        const result = await api.post(req, '/inventory/adjust', payload);
        if (apiOk(result)) {
            setFlash(req, 'success', (result.body && result.body.msg) || 'Stock adjustment saved.');
            return req.session.save(() => res.redirect('/inventory'));
        }
        setFlash(req, 'error', apiError(result, 'Could not save the stock adjustment.'));
        return req.session.save(() => res.redirect('/inventory/adjust'));
    } catch (err) { next(err); }
});

/* ── TALLY SYNC · Sync Dashboard (GET /sync-dashboard) ──────── */
router.get('/sync-dashboard', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/sync/summary');
        const data    = (body && body.data) || {};
        const summary = data.summary || {};
        const stats   = data.stats   || {};
        const modules = Array.isArray(data.modules) ? data.modules : [];
        const recent  = Array.isArray(data.recent)  ? data.recent  : [];

        const connected = !!summary.connected;
        const lastSeen  = summary.last_seen_at ? fmtDate(summary.last_seen_at) : '—';

        // Connection banner state (same keys the view's _sum reads).
        const syncSummary = {
            connected,
            agent_version:  summary.agent_version || '—',
            tally_version:  'TallyPrime',
            company:        summary.company || '—',
            last_heartbeat: lastSeen,
            last_sync:      lastSeen,
        };

        // Four headline stat cards — icon/tone preserved from mock.syncStats.
        const totalSynced = Number(stats.total_synced) || 0;
        const failed      = Number(stats.failed) || 0;
        const syncStats = [
            { label: 'Connection',           value: connected ? 'Connected' : 'Disconnected', icon: 'fa-plug-circle-check',    tone: 'green'  },
            { label: 'Last Sync',            value: lastSeen,                                 icon: 'fa-clock-rotate-left',    tone: 'blue'   },
            { label: 'Total Records Synced', value: totalSynced.toLocaleString('en-IN'),      icon: 'fa-circle-check',         tone: 'purple' },
            { label: 'Failed Records',       value: failed.toLocaleString('en-IN'),           icon: 'fa-triangle-exclamation', tone: 'amber'  },
        ];

        // Per-module sync rows (view does .toLocaleString on total/synced).
        const syncModules = modules.map((m) => ({
            module:    m.module || '',
            total:     Number(m.total) || 0,
            synced:    Number(m.synced) || 0,
            pending:   Number(m.pending) || 0,
            failed:    Number(m.failed) || 0,
            last_sync: m.last_sync ? fmtDate(m.last_sync) : '—',
        }));

        // Recent activity list ({module, record, status, time}). Status is
        // title-cased so it matches the pill labels (helper lowercases anyway).
        const recentSync = recent.map((r) => {
            const s = String(r.status || '');
            return {
                module: r.module || '',
                record: [r.record_type, r.record_id].filter(Boolean).join(' ') || '—',
                status: s ? s.charAt(0).toUpperCase() + s.slice(1) : '',
                time:   r.created_at ? fmtDate(r.created_at) : '',
            };
        });

        res.render('tally-sync/dashboard', {
            title: 'Sync Dashboard',
            activeMenu: 'sync-dash',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Tally Sync' },
            ],

            syncSummary,
            syncStats,
            syncModules,
            recentSync,
        });
    } catch (err) { next(err); }
});

/* ── TALLY SYNC · Sync Logs (GET /sync-logs) ────────────────── */
router.get('/sync-logs', async (req, res, next) => {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = parseInt(req.query.per_page, 10) || 10;
        const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        if (req.query.search)    qs.set('search',    String(req.query.search));
        if (req.query.module)    qs.set('module',    String(req.query.module));
        if (req.query.status)    qs.set('status',    String(req.query.status));
        if (req.query.direction) qs.set('direction', String(req.query.direction));

        const { body } = await api.get(req, `/sync/logs?${qs.toString()}`);
        const payload  = (body && body.data) || {};
        const rows     = Array.isArray(payload.data) ? payload.data : [];
        const meta     = payload.meta || { total: rows.length, page, per_page: perPage };

        // Map api columns → the view's expected keys.
        const logRows = rows.map((r) => ({
            id:        r.id,
            module:    r.module || '',
            record:    r.record_id || r.record_type || '',
            direction: r.direction || '',
            status:    txStatusLabel(r.status),
            message:   r.message || '',
            time:      fmtDate(r.synced_at || r.created_at),
        }));

        res.render('tally-sync/logs', {
            title: 'Sync Logs',
            activeMenu: 'sync-logs',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Sync Logs' },
            ],

            logRows,
            logsTotal: meta.total != null ? meta.total : logRows.length,
            page:      meta.page    != null ? meta.page    : page,
            perPage:   meta.per_page != null ? meta.per_page : perPage,

            // Filter dropdown option sources (still mock — api doesn't provide them).
            syncModuleNames: mock.syncModuleNames,
            syncDirections:  mock.syncDirections,
            syncLogStatuses: mock.syncLogStatuses,
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · Reports hub (GET /reports) — real working links ── */
router.get('/reports', (req, res) => {
    res.render('reports/index', {
        title: 'Reports',
        activeMenu: 'reports',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports' }],
        reportGroups: [
            { group: 'Sales & Purchase', reports: [
                { title: 'Sales Register', desc: 'All sales invoices with GST breakup', icon: 'fa-file-invoice', tone: 'blue', href: '/reports/sales-register' },
                { title: 'Day Book', desc: 'Every voucher (sales/purchase/receipt/payment), day-wise', icon: 'fa-book', tone: 'indigo', href: '/reports/day-book' },
            ]},
            { group: 'Outstanding', reports: [
                { title: 'Outstanding Receivables', desc: 'Customer balances — amount due to you', icon: 'fa-hand-holding-dollar', tone: 'green', href: '/reports/outstanding-receivables' },
                { title: 'Outstanding Payables', desc: 'Supplier balances — amount you owe', icon: 'fa-money-bill-transfer', tone: 'amber', href: '/reports/outstanding-payables' },
            ]},
            { group: 'Inventory', reports: [
                { title: 'Stock Summary', desc: 'Item-wise stock quantity + value', icon: 'fa-warehouse', tone: 'teal', href: '/reports/stock-summary' },
            ]},
            { group: 'Tax', reports: [
                { title: 'GST Summary', desc: 'Output vs input GST + net payable', icon: 'fa-percent', tone: 'purple', href: '/reports/gst-summary' },
            ]},
            { group: 'Financial Statements', reports: [
                { title: 'Trial Balance', desc: 'Ledger-wise Debit / Credit balances', icon: 'fa-scale-balanced', tone: 'indigo', href: '/reports/trial-balance' },
                { title: 'Profit & Loss A/c', desc: 'Trading account — sales vs purchases', icon: 'fa-chart-line', tone: 'green', href: '/reports/profit-loss' },
                { title: 'Balance Sheet', desc: 'Assets vs Liabilities (derived)', icon: 'fa-building-columns', tone: 'blue', href: '/reports/balance-sheet' },
            ]},
        ],
    });
});

/* ── REPORTS · Day Book (GET /reports/day-book) ─────────────── */
router.get('/reports/day-book', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/day-book');
        const d = (body && body.data) || {};
        const sm = d.summary || {};
        const grp = (v) => '₹' + Number(v || 0).toLocaleString('en-IN');
        res.render('reports/generic', {
            title: 'Day Book', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Day Book' }],
            summary: [
                { label: 'Sales',     value: grp(sm.sales),     icon: 'fa-file-invoice',    tone: 'blue' },
                { label: 'Purchases', value: grp(sm.purchase),  icon: 'fa-file-import',     tone: 'purple' },
                { label: 'Receipts',  value: grp(sm.receipts),  icon: 'fa-receipt',         tone: 'green' },
                { label: 'Payments',  value: grp(sm.payments),  icon: 'fa-money-bill-wave', tone: 'amber' },
            ],
            columns: [
                { key: 'date', label: 'Date' }, { key: 'vch_type', label: 'Type', pill: true },
                { key: 'vch_no', label: 'Voucher No', bold: true }, { key: 'party', label: 'Party' },
                { key: 'amount', label: 'Amount', num: true },
            ],
            rows: (d.data || []).map((r) => ({ ...r, date: fmtDate(r.date) })),
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · Outstanding Receivables / Payables ───────────── */
async function renderOutstanding(req, res, next, type) {
    try {
        const { body } = await api.get(req, `/reports/outstanding?type=${type}`);
        const d = (body && body.data) || {};
        const sm = d.summary || {};
        const isRec = type === 'receivable';
        res.render('reports/generic', {
            title: isRec ? 'Outstanding Receivables' : 'Outstanding Payables', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: isRec ? 'Receivables' : 'Payables' }],
            summary: [
                { label: 'Parties', value: String(sm.count || 0), icon: 'fa-user-group', tone: 'blue' },
                { label: isRec ? 'Total Receivable' : 'Total Payable', value: '₹' + Number(sm.total_outstanding || 0).toLocaleString('en-IN'), icon: 'fa-coins', tone: isRec ? 'green' : 'amber' },
            ],
            columns: [
                { key: 'party', label: isRec ? 'Customer' : 'Supplier', link: 'ledger_href' }, { key: 'gstin', label: 'GSTIN' },
                { key: 'opening', label: 'Opening', num: true },
                { key: 'invoiced', label: isRec ? 'Invoiced' : 'Billed', num: true },
                { key: 'settled', label: isRec ? 'Received' : 'Paid', num: true },
                { key: 'balance', label: 'Balance', num: true, bold: true },
            ],
            // Each party name links to its ledger statement (drill-down).
            rows: (d.data || []).map((r) => ({
                ...r,
                ledger_href: `/reports/ledger?party_type=${isRec ? 'customer' : 'supplier'}&party_id=${r.party_id}`,
            })),
            totals: { label: 'Total', balance: sm.total_outstanding || 0 },
        });
    } catch (err) { next(err); }
}
router.get('/reports/outstanding-receivables', (req, res, next) => renderOutstanding(req, res, next, 'receivable'));
router.get('/reports/outstanding-payables',    (req, res, next) => renderOutstanding(req, res, next, 'payable'));

/* ── REPORTS · Stock Summary (GET /reports/stock-summary) ───── */
router.get('/reports/stock-summary', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/stock-summary');
        const d = (body && body.data) || {};
        const sm = d.summary || {};
        res.render('reports/generic', {
            title: 'Stock Summary', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Stock Summary' }],
            summary: [
                { label: 'Items (SKU)', value: String(sm.skus || 0), icon: 'fa-box', tone: 'blue' },
                { label: 'Stock Value', value: '₹' + Number(sm.total_value || 0).toLocaleString('en-IN'), icon: 'fa-warehouse', tone: 'green' },
                { label: 'Low Stock', value: String(sm.low || 0), icon: 'fa-triangle-exclamation', tone: 'amber' },
                { label: 'Out of Stock', value: String(sm.out || 0), icon: 'fa-ban', tone: 'purple' },
            ],
            columns: [
                { key: 'name', label: 'Item', bold: true }, { key: 'category', label: 'Category' },
                { key: 'unit', label: 'Unit' }, { key: 'qty', label: 'Qty' },
                { key: 'rate', label: 'Rate', num: true }, { key: 'value', label: 'Value', num: true },
                { key: 'status', label: 'Status', pill: true },
            ],
            rows: d.data || [],
            totals: { label: 'Total', value: sm.total_value || 0 },
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · Party Ledger (GET /reports/ledger) ───────────── */
router.get('/reports/ledger', async (req, res, next) => {
    try {
        const ptype = req.query.party_type === 'supplier' ? 'supplier' : 'customer';
        const pid = Number(req.query.party_id) || 0;
        const { body } = await api.get(req, `/reports/ledger?party_type=${ptype}&party_id=${pid}`);
        if (!body || body.status !== 200 || !body.data) {
            setFlash(req, 'error', 'Could not load that ledger.');
            return req.session.save(() => res.redirect('/reports/outstanding-receivables'));
        }
        const d = body.data;
        res.render('reports/ledger', {
            title: (d.party && d.party.name) || 'Ledger', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' },
                { label: ptype === 'supplier' ? 'Outstanding Payables' : 'Outstanding Receivables', href: ptype === 'supplier' ? '/reports/outstanding-payables' : '/reports/outstanding-receivables' },
                { label: 'Ledger' }],
            party: d.party, opening: d.opening, closing: d.closing, totals: d.totals, rows: d.data, fmtDate,
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · Trial Balance / P&L / Balance Sheet (derived) ── */
router.get('/reports/trial-balance', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/trial-balance');
        const d = (body && body.data) || {};
        res.render('reports/generic', {
            title: 'Trial Balance', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Trial Balance' }],
            columns: [
                { key: 'ledger', label: 'Ledger / Group', bold: true },
                { key: 'debit', label: 'Debit', num: true }, { key: 'credit', label: 'Credit', num: true },
            ],
            rows: d.data || [],
            totals: { label: 'Total', debit: (d.totals || {}).debit || 0, credit: (d.totals || {}).credit || 0 },
        });
    } catch (err) { next(err); }
});
router.get('/reports/profit-loss', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/profit-loss');
        const d = (body && body.data) || {};
        res.render('reports/statement', {
            title: 'Profit & Loss A/c', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Profit & Loss' }],
            leftTitle: 'Particulars (Dr)', rightTitle: 'Particulars (Cr)',
            leftRows: d.left || [], rightRows: d.right || [], leftTotal: d.left_total || 0, rightTotal: d.right_total || 0,
            note: 'Derived from cloud sales/purchase (ex-GST).',
            summary: [
                { label: 'Sales', value: '₹' + Number(d.sales || 0).toLocaleString('en-IN'), icon: 'fa-file-invoice', tone: 'blue' },
                { label: 'Purchases', value: '₹' + Number(d.purchases || 0).toLocaleString('en-IN'), icon: 'fa-file-import', tone: 'purple' },
                { label: (d.gross_profit || 0) >= 0 ? 'Gross Profit' : 'Gross Loss', value: '₹' + Number(Math.abs(d.gross_profit || 0)).toLocaleString('en-IN'), icon: 'fa-chart-line', tone: (d.gross_profit || 0) >= 0 ? 'green' : 'amber' },
            ],
        });
    } catch (err) { next(err); }
});
router.get('/reports/balance-sheet', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/balance-sheet');
        const d = (body && body.data) || {};
        res.render('reports/statement', {
            title: 'Balance Sheet', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Balance Sheet' }],
            leftTitle: 'Liabilities', rightTitle: 'Assets',
            leftRows: d.liabilities || [], rightRows: d.assets || [], leftTotal: d.liab_total || 0, rightTotal: d.asset_total || 0,
            note: 'Derived from cloud transactions (approximate).',
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · GST Summary (GET /reports/gst-summary) ───────── */
router.get('/reports/gst-summary', async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/reports/gst-summary');
        const d = (body && body.data) || {};
        res.render('reports/gst-summary', {
            title: 'GST Summary', activeMenu: 'reports',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'GST Summary' }],
            outward: d.outward || {}, inward: d.inward || {}, net_payable: d.net_payable || 0,
        });
    } catch (err) { next(err); }
});

/* ── REPORTS · Sales Register (GET /reports/sales-register) ─── */
router.get('/reports/sales-register', async (req, res, next) => {
    try {
        // Forward pagination + report filters to the api.
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = parseInt(req.query.per_page, 10) || 10;
        const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        if (req.query.date_from)   qs.set('date_from', String(req.query.date_from));
        if (req.query.date_to)     qs.set('date_to', String(req.query.date_to));
        if (req.query.status)      qs.set('status', String(req.query.status));
        if (req.query.customer_id) qs.set('customer_id', String(req.query.customer_id));

        const { body } = await api.get(req, `/reports/sales-register?${qs.toString()}`);
        const payload = (body && body.data) || {};

        // Report rows → the table's expected keys (date pre-formatted, status humanised).
        const data = Array.isArray(payload.data) ? payload.data : [];
        const rows = data.map((r) => ({
            date:       fmtDate(r.date),
            invoice_no: r.invoice_no || '',
            customer:   r.customer || '',
            gstin:      r.gstin || '—',
            taxable:    Number(r.taxable) || 0,
            cgst:       Number(r.cgst) || 0,
            sgst:       Number(r.sgst) || 0,
            total:      Number(r.total) || 0,
            status:     txStatusLabel(r.status),
        }));

        // Summary object → the 4 stat-cards (icon/tone copied from mock.reportSalesSummary).
        const s   = payload.summary || {};
        const inr = (v) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
        const summary = [
            { label: 'Total Invoices', value: String(Number(s.count) || 0),  icon: 'fa-file-invoice',      tone: 'blue'   },
            { label: 'Total Taxable',  value: inr(s.total_taxable),           icon: 'fa-indian-rupee-sign', tone: 'purple' },
            { label: 'Total GST',      value: inr(s.total_gst),               icon: 'fa-percent',           tone: 'amber'  },
            { label: 'Total Amount',   value: inr(s.total_amount),            icon: 'fa-sack-dollar',       tone: 'green'  },
        ];

        res.render('reports/sales-register', {
            title: 'Sales Register',
            activeMenu: 'reports',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Reports', href: '/reports' },
                { label: 'Sales Register' },
            ],
            rows,
            summary,
            // Filter option lists the api doesn't provide — keep mock.
            customerNames: mock.customerNames,
            locationNames: mock.locationNames,
        });
    } catch (err) { next(err); }
});

/* ── SETTINGS · Users listing (GET /users) ──────────────────── */
router.get('/users', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/users');
        const userRows = rows.map((r) => ({
            id:         r.id,
            name:       r.name || '',
            email:      r.email || '',
            mobile:     r.mobile || '',
            role:       r.role || '',
            last_login: fmtDate(r.last_login_at),
            status:     r.status || '',
            created_at: fmtDate(r.created_at),
        }));
        res.render('users/list', {
            title: 'Users',
            activeMenu: 'users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Users' },
            ],

            userRows,
            usersTotal: meta.total || 0,
            page:       meta.page || 1,
            perPage:    meta.per_page || 10,

            // Role filter option source (still mock — the api doesn't provide it).
            roles:      mock.roles,
        });
    } catch (err) { next(err); }
});

/* ── SETTINGS · Add User (GET /users/add) ─────────────────────
 * Role dropdown is fetched from the api as {id,name} so the form submits a
 * real role_id (the user-create endpoint needs it). */
router.get('/users/add', async (req, res, next) => {
    try {
        const roleOptions = await fetchOptions(req, '/roles');
        res.render('users/form', {
            title: 'Add User',
            activeMenu: 'users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Users', href: '/users' },
                { label: 'Add User' },
            ],
            roleOptions,
            locationNames: mock.locationNames,
        });
    } catch (err) { next(err); }
});

/* ── POST /users — create a tenant user via the api ───────────── */
router.post('/users', async (req, res, next) => {
    try {
        const b = req.body;
        // The form has password + confirm; guard the mismatch here for a
        // friendly message (the api also validates length).
        if (b.password !== undefined && b.password !== b.password_confirm) {
            setFlash(req, 'error', 'Passwords do not match.');
            return req.session.save(() => res.redirect('/users/add'));
        }
        const payload = {
            name:        b.name,
            email:       b.email,
            mobile:      b.mobile || undefined,
            role_id:     _num(b.role_id),
            password:    b.password,
            status:      b.status || 'Active',
            location_id: _num(b.location_id),
        };
        const result = await api.post(req, '/users', payload);
        if (apiOk(result)) {
            setFlash(req, 'success', 'User created successfully.');
            return req.session.save(() => res.redirect('/users'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create user.'));
        return req.session.save(() => res.redirect('/users/add'));
    } catch (err) { next(err); }
});

/* ── SETTINGS · Roles & Permissions (GET /roles) — REAL API ────
 * Loads the live matrix (Super-Admin only); on any non-200 (e.g. a
 * non-super-admin) it falls back to the mock so the page still renders. */
router.get('/roles', async (req, res, next) => {
    try {
        let roleNames, roleUserCounts, rbacModules, rbacActions, rbacPermissions, roleIds = {};

        const { body } = await api.get(req, '/permissions/matrix');
        const d = (body && body.status === 200 && body.data) ? body.data : null;
        if (d) {
            roleNames       = d.roles.map((r) => r.name);
            roleUserCounts  = {};
            d.roles.forEach((r) => { roleUserCounts[r.name] = r.user_count; roleIds[r.name] = r.id; });
            rbacModules     = d.modules;          // [{ key, label }]
            rbacActions     = d.actions;          // ['view',...]
            rbacPermissions = d.permissions;      // { roleName: { moduleKey: { action: true } } }
        } else {
            // Fallback (mock) — keeps the screen usable for non-super-admins.
            roleNames = mock.roles; roleUserCounts = mock.roleUserCounts;
            rbacModules = (mock.rbacModules || []).map((m) => ({ key: m, label: m }));
            rbacActions = mock.rbacActions; rbacPermissions = mock.rbacPermissions;
        }

        res.render('roles/index', {
            title: 'Roles & Permissions',
            activeMenu: 'roles',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Roles & Permissions' }],
            roles: roleNames, roleUserCounts, rbacModules, rbacActions, rbacPermissions, roleIds,
            pageScript: '<script src="/js/rbac.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── POST /roles/:id/permissions — save a role's permission set ──
 * The matrix (rbac.js) posts the checked permission slugs as JSON. */
router.post('/roles/:id/permissions', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        let slugs = [];
        try { slugs = JSON.parse(req.body.slugs || '[]'); } catch (_) { slugs = []; }
        if (!Array.isArray(slugs)) slugs = [];
        const result = await api.put(req, `/roles/${id}/permissions`, { slugs });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Permissions updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update permissions.'));
        return req.session.save(() => res.redirect('/roles'));
    } catch (err) { next(err); }
});

/* ── SETTINGS · Settings (GET /settings) ────────────────────── */
router.get('/settings', async (req, res, next) => {
    try {
        // Fetch the company profile + arbitrary settings key/values from the api.
        const { body } = await api.get(req, '/settings');
        const payload  = (body && body.data) || {};
        const companyProfile  = payload.company  || {};
        const companySettings = payload.settings || {};

        res.render('settings/index', {
            title: 'Settings',
            activeMenu: 'settings',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Settings' },
            ],

            // API-backed data, made available to the view (the .ejs inputs
            // still need name= + prefill wiring to surface these values).
            companyProfile,            // = body.data.company  {name,email,mobile,gst_number,pan_number,financial_year,address}
            companySettings,           // = body.data.settings {arbitrary key/values}

            // Select option sources the API does not provide (kept on mock).
            financialYears: mock.financialYears,
            gstRates:       mock.gstRates,
            paymentTerms:   mock.paymentTerms,
        });
    } catch (err) { next(err); }
});

/* ── PAGE 1 — Customers listing (GET /customers) ─────────────────
 * WIRED TO THE REAL API. Calls GET /api/v1/customers (Bearer + company
 * scope ride the session via apiClient), then maps the api rows to the
 * shape customers/list.ejs already expects (gst_number → gst, ISO date
 * → dd/mm/yyyy). Filter dropdowns stay on mock for now (cosmetic) until
 * those masters are wired too. On any api error the page renders empty
 * with a flash-free fallback. */
router.get('/customers', async (req, res, next) => {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = parseInt(req.query.per_page, 10) || 10;
        const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        if (req.query.search) qs.set('search', String(req.query.search));
        if (req.query.status) qs.set('status', String(req.query.status));
        if (req.query.sort)   qs.set('sort',  String(req.query.sort));
        if (req.query.order)  qs.set('order', String(req.query.order));

        const { body } = await api.get(req, `/customers?${qs.toString()}`);
        const payload  = (body && body.data) || {};
        const rows     = Array.isArray(payload.data) ? payload.data : [];
        const meta     = payload.meta || { total: rows.length, page, per_page: perPage };

        // Map api columns → the view's expected keys.
        const customers = rows.map((r) => ({
            id:              r.id,
            name:            r.name,
            location:        r.location || '',
            mobile:          r.mobile || '',
            gst:             r.gst_number || '',
            opening_balance: r.opening_balance,
            credit_limit:    r.credit_limit,
            sales_person:    r.sales_person || '',
            status:          r.status,
            created_at:      fmtDate(r.created_at),
        }));

        res.render('customers/list', {
            title: 'Customers',
            activeMenu: 'customers',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Customers' },
            ],

            customers,
            customersTotal: meta.total,
            page:           meta.page,
            perPage:        meta.per_page,

            // Filter dropdown option sources (still mock for now).
            locations:      mock.locations,
            salesPersons:   mock.salesPersons,
            customerGroups: mock.customerGroups,
        });
    } catch (err) {
        next(err);
    }
});

/* ── PAGE 2 — Add Customer (GET /customers/add) ─────────────────
 * FK dropdowns (Location / Sales Person / Customer Group) are fetched
 * from the api as { id, name } so the form submits real foreign keys. */
router.get('/customers/add', async (req, res, next) => {
    try {
        const [locationOptions, salesPersonOptions, customerGroupOptions] = await Promise.all([
            fetchOptions(req, '/locations'),
            fetchOptions(req, '/sales-persons'),
            fetchOptions(req, '/customer-groups'),
        ]);
        res.render('customers/form', {
            title: 'Add Customer',
            activeMenu: 'customers',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Customers', href: '/customers' },
                { label: 'Add Customer' },
            ],
            locationOptions, salesPersonOptions, customerGroupOptions,
        });
    } catch (err) { next(err); }
});

/* ── POST /customers — create via the api ───────────────────────
 * Forwards only the known customer columns to POST /api/v1/customers,
 * flashes the result, and redirects to the list (or back to the form
 * on a validation error). */
router.post('/customers', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            name:              b.name,
            mobile:            b.mobile || undefined,
            alternate_mobile:  b.alternate_mobile || undefined,
            email:             b.email || undefined,
            location_id:       num(b.location_id),
            sales_person_id:   num(b.sales_person_id),
            customer_group_id: num(b.customer_group_id),
            opening_balance:   num(b.opening_balance),
            credit_limit:      num(b.credit_limit),
            status:            b.status || 'Active',
            billing_address:   b.billing_address || undefined,
            shipping_address:  b.shipping_address || undefined,
            is_tally_ledger:   asBool(b.is_tally_ledger),
            notes:             b.notes || undefined,
            internal_remarks:  b.internal_remarks || undefined,
        };
        const result = await api.post(req, '/customers', payload);
        if (apiOk(result)) {
            setFlash(req, 'success', 'Customer created successfully.');
            return req.session.save(() => res.redirect('/customers'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create customer.'));
        return req.session.save(() => res.redirect('/customers/add'));
    } catch (err) { next(err); }
});

/* ── SETTINGS · save (POST /settings) ───────────────────────────
 * The form posts company[...] (→ companies row) + settings[...] (→ the
 * key/value bag); express extended parsing gives req.body.company /
 * req.body.settings as nested objects. Forwarded to PUT /settings. */
router.post('/settings', async (req, res, next) => {
    try {
        const b = req.body || {};
        const payload = {};
        if (b.company && typeof b.company === 'object') payload.company = b.company;
        if (b.settings && typeof b.settings === 'object') payload.settings = b.settings;
        const result = await api.put(req, '/settings', payload);
        if (apiOk(result)) setFlash(req, 'success', 'Settings saved successfully.');
        else setFlash(req, 'error', apiError(result, 'Could not save settings.'));
        return req.session.save(() => res.redirect('/settings'));
    } catch (err) { next(err); }
});

/* ── EDIT (prefilled form) + UPDATE for the 6 API masters ────────
 * GET  /{r}/:id/edit → fetch the record + FK options → render the SAME
 *                      form.ejs (it prefills from `record`, dual-mode).
 * POST /{r}/:id       → build the same payload as create → api.put.
 * Mirrors each resource's add/create route (option sources + field map). */
async function fetchRecord(req, basePath, id) {
    const { body } = await api.get(req, `${basePath}/${id}`);
    return (body && body.data) ? body.data : null;
}
const _num = (v) => (v === '' || v == null ? undefined : Number(v));

/* Customers */
router.get('/customers/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, locationOptions, salesPersonOptions, customerGroupOptions] = await Promise.all([
            fetchRecord(req, '/customers', id),
            fetchOptions(req, '/locations'),
            fetchOptions(req, '/sales-persons'),
            fetchOptions(req, '/customer-groups'),
        ]);
        if (!record) { setFlash(req, 'error', 'Customer not found.'); return req.session.save(() => res.redirect('/customers')); }
        res.render('customers/form', {
            title: 'Edit Customer', activeMenu: 'customers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Customers', href: '/customers' }, { label: 'Edit Customer' }],
            record, locationOptions, salesPersonOptions, customerGroupOptions,
        });
    } catch (err) { next(err); }
});
router.post('/customers/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, mobile: b.mobile || undefined, alternate_mobile: b.alternate_mobile || undefined,
            email: b.email || undefined, location_id: _num(b.location_id), sales_person_id: _num(b.sales_person_id),
            customer_group_id: _num(b.customer_group_id), opening_balance: _num(b.opening_balance),
            credit_limit: _num(b.credit_limit), status: b.status || 'Active',
            billing_address: b.billing_address || undefined, shipping_address: b.shipping_address || undefined,
            is_tally_ledger: asBool(b.is_tally_ledger), notes: b.notes || undefined, internal_remarks: b.internal_remarks || undefined,
        };
        const result = await api.put(req, `/customers/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Customer updated successfully.'); return req.session.save(() => res.redirect('/customers')); }
        setFlash(req, 'error', apiError(result, 'Could not update customer.'));
        return req.session.save(() => res.redirect(`/customers/${id}/edit`));
    } catch (err) { next(err); }
});

/* Suppliers */
router.get('/suppliers/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, locationOptions] = await Promise.all([fetchRecord(req, '/suppliers', id), fetchOptions(req, '/locations')]);
        if (!record) { setFlash(req, 'error', 'Supplier not found.'); return req.session.save(() => res.redirect('/suppliers')); }
        res.render('suppliers/form', {
            title: 'Edit Supplier', activeMenu: 'suppliers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Suppliers', href: '/suppliers' }, { label: 'Edit Supplier' }],
            record, locationOptions, supplierGroups: mock.supplierGroups, paymentTerms: mock.paymentTerms,
        });
    } catch (err) { next(err); }
});
router.post('/suppliers/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, mobile: b.mobile || undefined, alternate_mobile: b.alternate_mobile || undefined,
            email: b.email || undefined, gst_number: b.gst_number || undefined, supplier_group: b.supplier_group || undefined,
            location_id: _num(b.location_id), opening_balance: _num(b.opening_balance), payment_terms: b.payment_terms || undefined,
            status: b.status || 'Active', is_tally_ledger: asBool(b.is_tally_ledger),
        };
        const result = await api.put(req, `/suppliers/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Supplier updated successfully.'); return req.session.save(() => res.redirect('/suppliers')); }
        setFlash(req, 'error', apiError(result, 'Could not update supplier.'));
        return req.session.save(() => res.redirect(`/suppliers/${id}/edit`));
    } catch (err) { next(err); }
});

/* Products */
router.get('/products/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, categoryOptions] = await Promise.all([fetchRecord(req, '/products', id), fetchOptions(req, '/categories')]);
        if (!record) { setFlash(req, 'error', 'Product not found.'); return req.session.save(() => res.redirect('/products')); }
        res.render('products/form', {
            title: 'Edit Product', activeMenu: 'products',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Products', href: '/products' }, { label: 'Edit Product' }],
            record, categoryOptions, units: mock.units, gstRates: mock.gstRates,
        });
    } catch (err) { next(err); }
});
router.post('/products/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, sku: b.sku || undefined, category_id: _num(b.category_id), unit: b.unit || undefined,
            hsn_code: b.hsn_code || undefined, gst_rate: b.gst_rate ? parseFloat(String(b.gst_rate)) : undefined,
            purchase_price: _num(b.purchase_price), sales_price: _num(b.sales_price), opening_stock: _num(b.opening_stock),
            status: b.status || 'Active', is_tally_item: asBool(b.is_tally_item), description: b.description || undefined,
        };
        const result = await api.put(req, `/products/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Product updated successfully.'); return req.session.save(() => res.redirect('/products')); }
        setFlash(req, 'error', apiError(result, 'Could not update product.'));
        return req.session.save(() => res.redirect(`/products/${id}/edit`));
    } catch (err) { next(err); }
});

/* Categories */
router.get('/categories/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, parentOptions] = await Promise.all([fetchRecord(req, '/categories', id), fetchOptions(req, '/categories')]);
        if (!record) { setFlash(req, 'error', 'Category not found.'); return req.session.save(() => res.redirect('/categories')); }
        res.render('categories/form', {
            title: 'Edit Category', activeMenu: 'categories',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Categories', href: '/categories' }, { label: 'Edit Category' }],
            record, parentOptions: parentOptions.filter((o) => o.id !== id),
        });
    } catch (err) { next(err); }
});
router.post('/categories/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = { name: b.name, parent_id: _num(b.parent_id), status: b.status || 'Active' };
        const result = await api.put(req, `/categories/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Category updated successfully.'); return req.session.save(() => res.redirect('/categories')); }
        setFlash(req, 'error', apiError(result, 'Could not update category.'));
        return req.session.save(() => res.redirect(`/categories/${id}/edit`));
    } catch (err) { next(err); }
});

/* Locations */
router.get('/locations/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const record = await fetchRecord(req, '/locations', id);
        if (!record) { setFlash(req, 'error', 'Location not found.'); return req.session.save(() => res.redirect('/locations')); }
        res.render('locations/form', {
            title: 'Edit Location', activeMenu: 'locations',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Locations', href: '/locations' }, { label: 'Edit Location' }],
            record, states: mock.states, salesPersons: mock.salesPersons,
        });
    } catch (err) { next(err); }
});
router.post('/locations/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, code: b.code || undefined, city: b.city || undefined, state: b.state || undefined,
            pincode: b.pincode || undefined, mobile: b.mobile || undefined, manager: b.manager || undefined,
            status: b.status || 'Active', is_tally_godown: asBool(b.is_tally_godown),
        };
        const result = await api.put(req, `/locations/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Location updated successfully.'); return req.session.save(() => res.redirect('/locations')); }
        setFlash(req, 'error', apiError(result, 'Could not update location.'));
        return req.session.save(() => res.redirect(`/locations/${id}/edit`));
    } catch (err) { next(err); }
});

/* Sales Persons */
router.get('/sales-persons/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const record = await fetchRecord(req, '/sales-persons', id);
        if (!record) { setFlash(req, 'error', 'Sales person not found.'); return req.session.save(() => res.redirect('/sales-persons')); }
        res.render('sales-persons/form', {
            title: 'Edit Sales Person', activeMenu: 'sales',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Sales Persons', href: '/sales-persons' }, { label: 'Edit Sales Person' }],
            record, locationOptions: mock.locationsList,
        });
    } catch (err) { next(err); }
});
router.post('/sales-persons/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, employee_code: b.employee_code || undefined, mobile: b.mobile || undefined,
            email: b.email || undefined, joining_date: b.joining_date || undefined, status: b.status || 'Active',
        };
        const result = await api.put(req, `/sales-persons/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Sales person updated successfully.'); return req.session.save(() => res.redirect('/sales-persons')); }
        setFlash(req, 'error', apiError(result, 'Could not update sales person.'));
        return req.session.save(() => res.redirect(`/sales-persons/${id}/edit`));
    } catch (err) { next(err); }
});

/* ── Invoice PDF / print (Tally-style tax invoice) ──────────────
 * GET /{sales|purchase}-invoices/:id/print → a standalone, print-optimised
 * tax-invoice page (layout:false). The browser's "Save as PDF" produces the
 * PDF. Assembles seller (company) + buyer (customer/supplier) + line items
 * (product names resolved) from the api. */
function amountInWords(num) {
    num = Math.round(Number(num) || 0);
    if (num === 0) return 'Zero Rupees Only';
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
        'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = (n) => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : ''));
    const three = (n) => (n >= 100 ? a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : '');
    let words = '';
    const crore = Math.floor(num / 10000000); num %= 10000000;
    const lakh = Math.floor(num / 100000);    num %= 100000;
    const thousand = Math.floor(num / 1000);  num %= 1000;
    if (crore)    words += three(crore) + ' Crore ';
    if (lakh)     words += three(lakh) + ' Lakh ';
    if (thousand) words += three(thousand) + ' Thousand ';
    if (num)      words += three(num);
    return words.trim().replace(/\s+/g, ' ') + ' Rupees Only';
}

async function renderInvoicePrint(req, res, next, apiBase) {
    try {
        const id = Number(req.params.id);
        const r = await api.get(req, `${apiBase}/${id}`);
        if (!apiOk(r) || !r.body.data) { return res.status(404).render('errors/404', { title: 'Not Found', activeMenu: '', breadcrumb: [] }); }
        const invoice = r.body.data;
        const isPurchase = apiBase.indexOf('purchase') > -1;

        // Buyer / supplier party (name + GSTIN + address).
        let party = { name: (isPurchase ? invoice.supplier : invoice.customer) || '', gst: '', address: '' };
        const partyId = isPurchase ? invoice.supplier_id : invoice.customer_id;
        if (partyId) {
            const p = await api.get(req, `${isPurchase ? '/suppliers' : '/customers'}/${partyId}`);
            if (apiOk(p) && p.body.data) {
                party = { name: p.body.data.name, gst: p.body.data.gst_number || '',
                    address: p.body.data.billing_address || p.body.data.address || '' };
            }
        }

        // Seller company profile (from settings).
        let seller = { name: (res.locals.company && res.locals.company.name) || 'Company', gst: '', pan: '', address: '' };
        const s = await api.get(req, '/settings');
        if (apiOk(s) && s.body.data && s.body.data.company) {
            const c = s.body.data.company;
            seller = { name: c.name, gst: c.gst_number || '', pan: c.pan_number || '', address: c.address || '' };
        }

        // Resolve product names for the line items.
        const prodOpts = await fetchOptions(req, '/products');
        const prodMap = {};
        prodOpts.forEach((p) => { prodMap[p.id] = p.name; });
        const items = (invoice.items || []).map((it, i) => ({
            sno: i + 1,
            name: it.description || prodMap[it.product_id] || 'Item',
            hsn: it.hsn || '', qty: Number(it.quantity) || 0, unit: it.unit || '',
            rate: Number(it.rate) || 0, taxable: Number(it.taxable) || 0,
            gst_rate: Number(it.gst_rate) || 0, gst_amount: Number(it.gst_amount) || 0,
            amount: Number(it.amount) || 0,
        }));

        res.render('invoices/print', {
            layout: false,
            heading: isPurchase ? 'PURCHASE INVOICE' : 'TAX INVOICE',
            invoice, seller, party, items,
            words: amountInWords(invoice.total),
            fmtDate,
        });
    } catch (err) { next(err); }
}

router.get('/sales-invoices/:id/print',   (req, res, next) => renderInvoicePrint(req, res, next, '/sales-invoices'));
router.get('/purchase-invoices/:id/print', (req, res, next) => renderInvoicePrint(req, res, next, '/purchase-invoices'));

/* ── TRANSACTIONS · Journals (list / add / create) ──────────── */
router.get('/journals', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/journals');
        const journalRows = rows.map((r) => ({
            id: r.id, voucher_no: r.voucher_no, vch_type: r.vch_type || 'Journal', date: fmtDate(r.journal_date),
            dr_ledger: r.dr_ledger, cr_ledger: r.cr_ledger, narration: r.narration || '',
            amount: r.amount, status: txStatusLabel(r.status),
        }));
        res.render('journals/list', {
            title: 'Journals', activeMenu: 'journals',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Journals' }],
            journalRows, journalsTotal: meta.total, page: meta.page, perPage: meta.per_page,
        });
    } catch (err) { next(err); }
});
router.get('/journals/add', async (req, res, next) => {
    try {
        const [custs, sups] = await Promise.all([fetchOptions(req, '/customers'), fetchOptions(req, '/suppliers')]);
        const ledgerNames = [...custs, ...sups].map((o) => o.name);
        res.render('journals/form', {
            title: 'Add Journal Voucher', activeMenu: 'journals',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Journals', href: '/journals' }, { label: 'Add Journal' }],
            ledgerNames,
        });
    } catch (err) { next(err); }
});
router.post('/journals', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            vch_type: b.vch_type || 'Journal',
            journal_date: b.journal_date || undefined, dr_ledger: b.dr_ledger || undefined,
            cr_ledger: b.cr_ledger || undefined, amount: _num(b.amount), narration: b.narration || undefined,
        };
        const result = await api.post(req, '/journals', payload);
        if (apiOk(result)) {
            const no = result.body.data && result.body.data.voucher_no;
            setFlash(req, 'success', `Journal ${no || ''} created — will sync to Tally.`);
            return req.session.save(() => res.redirect('/journals'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create the journal.'));
        return req.session.save(() => res.redirect('/journals/add'));
    } catch (err) { next(err); }
});

/* ── Generic DELETE handler (POST /:resource/:id/delete) ─────────
 * Backs the custom Delete popup on every list page. Whitelisted to the
 * resources the api actually exposes a DELETE for, then forwards to
 * DELETE /api/v1/{resource}/{id}, flashes the result, and returns to the
 * list. Kept LAST so its catch-all params never shadow a specific route. */
const DELETABLE = new Set([
    'customers', 'suppliers', 'products', 'categories', 'locations', 'sales-persons',
    'customer-groups', 'sales-invoices', 'purchase-invoices', 'payments', 'receipts', 'journals',
]);
router.post('/:resource/:id/delete', async (req, res, next) => {
    try {
        const { resource } = req.params;
        const id = Number(req.params.id);
        const back = req.get('Referer') || '/' + resource;
        if (!DELETABLE.has(resource) || !Number.isInteger(id)) {
            setFlash(req, 'error', 'This record cannot be deleted here.');
            return req.session.save(() => res.redirect(back));
        }
        const result = await api.del(req, `/${resource}/${id}`);
        if (apiOk(result)) setFlash(req, 'success', 'Record deleted successfully.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the record.'));
        return req.session.save(() => res.redirect('/' + resource));
    } catch (err) { next(err); }
});

module.exports = router;
