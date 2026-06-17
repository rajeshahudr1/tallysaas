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
const { friendlyReason, RESTART_HELP } = require('../Helpers/syncReason');

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

/* ── License switcher (GET /switch-license/:id) — super-admin only ──
 * The super-admin's top selector lists LICENSES (the customers they manage);
 * this remembers the chosen license id on the session. The license name is
 * resolved fresh by the global middleware from /super-admin/licenses. */
router.get('/switch-license/:id', (req, res) => {
    const id = Number(req.params.id);
    const back = req.get('Referer') || '/';
    const isSuper = req.session && req.session.user && req.session.user.role_slug === 'super-admin';
    if (isSuper && Number.isInteger(id) && id > 0) {
        req.session.licenseId = id;
        // Reset the company so the global middleware re-defaults to THIS
        // license's first company (and sends its X-Company-Id).
        req.session.companyId = null;
        req.session.flash = { type: 'success', msg: 'License selected.' };
    }
    return req.session.save(() => res.redirect(back));
});

/* ── Open in Tally (POST /open-in-tally/:companyId) ─────────────
 * From the header company switcher, queue an "open_company" command for the
 * customer-side agent (running next to Tally). The api inserts an
 * agent_commands row scoped to the caller's license; the agent picks it up on
 * its next poll and opens that company in Tally (clean tally.ini rewrite, or
 * a UI-automation fallback for Educational Tally). We just relay the api's
 * msg to a flash and bounce back to the page the user was on. */
router.post('/open-in-tally/:companyId', async (req, res) => {
    const id   = Number(req.params.companyId);
    const back = req.get('Referer') || '/';
    if (!Number.isInteger(id) || id <= 0) {
        setFlash(req, 'error', 'Invalid company.');
        return req.session.save(() => res.redirect(back));
    }
    try {
        const result = await api.post(req, '/account/agent/open-company', { company_id: id });
        // The api returns { status:201, show, msg, data } on success; treat any
        // 2xx body.status as success and surface the api's own message.
        const bodyStatus = result && result.body && result.body.status;
        const ok  = bodyStatus && bodyStatus >= 200 && bodyStatus < 300;
        const msg = (result && result.body && result.body.msg)
            || (ok ? 'Open command queued. The agent will open it in Tally shortly.'
                   : apiError(result, 'Could not queue the open command.'));
        setFlash(req, ok ? 'success' : 'error', msg);
    } catch (_) {
        setFlash(req, 'error', 'Could not reach the API server.');
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

/* Format an ISO/Date string to "dd/mm/yyyy hh:mm AM/PM" (date AND time) for the
 * Sync surfaces. Returns '' for empty so callers can fall back to a dash. */
function fmtDateTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
           `${p(h)}:${p(d.getMinutes())} ${ampm}`;
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

/* Fetch config-enumeration dropdown lists from the api's single source
 * (GET /config/options — api/Helpers/appOptions.js), so the web BFF and the
 * mobile app share ONE list (nothing hardcoded; one place to change).
 *
 * Takes an array of snake_case keys (e.g. ['supplier_groups','payment_terms'])
 * and returns an object keyed by the camelCase render-local NAMES the EJS
 * views already expect (e.g. { supplierGroups, paymentTerms }) — so callers
 * just spread the result into res.render with no renaming.
 *
 * Unlike LIST endpoints, /config/options returns body.data as a FLAT
 * key->string[] map (so read body.data[snake_key] directly, NOT
 * body.data.data). Per requested key: use the api array when present, else
 * fall back to the matching mock.<camelCase> array (resilience if the api is
 * briefly unreachable). */
const CONFIG_KEY_TO_LOCAL = {
    supplier_groups: 'supplierGroups',
    customer_groups: 'customerGroups',
    payment_terms:   'paymentTerms',
    payment_modes:   'paymentModes',
    gst_rates:       'gstRates',
    units:           'units',
    financial_years: 'financialYears',
};
async function fetchConfig(req, keys) {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const { body } = await api.get(req, `/config/options?keys=${wanted.join(',')}`);
    const ok = body && body.status === 200 && body.data;
    const out = {};
    for (const key of wanted) {
        const local = CONFIG_KEY_TO_LOCAL[key];
        if (!local) continue;
        out[local] = (ok && Array.isArray(body.data[key])) ? body.data[key] : mock[local];
    }
    return out;
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

/* Super-admin gate for the cross-tenant Licenses screens. The session user's
 * role_slug is set at login (api echoes it on body.data.user). A non-super-
 * admin gets a 403 (HTML page or JSON envelope) rather than a silent pass —
 * the api also enforces this, but we block here so the routes/menu never leak. */
function requireSuperAdmin(req, res, next) {
    const u = req.session && req.session.user;
    if (u && u.role_slug === 'super-admin') return next();
    if (req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1) {
        return res.status(403).json({ status: 403, show: true, msg: 'Super-admin access required.' });
    }
    return res.status(403).render('errors/404', {
        title: 'Forbidden',
        activeMenu: '',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Forbidden' }],
    });
}

/* License-admin (tenant) gate for the custom-role management screens. Mirrors
 * requireSuperAdmin but checks role_slug==='company-admin'. A non-company-admin
 * gets a 403 (HTML page or JSON envelope) rather than a silent pass — the api
 * also enforces can('users',*), but we block here so the routes/menu never leak. */
function requireCompanyAdmin(req, res, next) {
    const u = req.session && req.session.user;
    if (u && u.role_slug === 'company-admin') return next();
    if (req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1) {
        return res.status(403).json({ status: 403, show: true, msg: 'License-admin access required.' });
    }
    return res.status(403).render('errors/404', {
        title: 'Forbidden',
        activeMenu: '',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Forbidden' }],
    });
}

/* Role-management gate: BOTH the super-admin (manages every role across
 * licenses + global templates) AND the company-admin (manages their own
 * license's custom roles) may reach the /roles-admin screens. The api enforces
 * the finer hierarchy (super-admin vs license-scoped, PROTECTED_SLUGS); this
 * just keeps the routes/menu from leaking to plain users. */
function requireRoleManager(req, res, next) {
    const u = req.session && req.session.user;
    const slug = u && u.role_slug;
    if (slug === 'super-admin' || slug === 'company-admin') return next();
    if (req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1) {
        return res.status(403).json({ status: 403, show: true, msg: 'Role-management access required.' });
    }
    return res.status(403).render('errors/404', {
        title: 'Forbidden',
        activeMenu: '',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Forbidden' }],
    });
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
        // Date-range picker (header pill). Default = current month (1st → today)
        // so the pill always shows a concrete, working range; the user can
        // change it. Both dates flow to the api, which scopes the money metrics.
        const _isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        const _today = new Date();
        const _p2 = (n) => String(n).padStart(2, '0');
        const todayStr = `${_today.getFullYear()}-${_p2(_today.getMonth() + 1)}-${_p2(_today.getDate())}`;
        const monthStartStr = `${todayStr.slice(0, 8)}01`;
        let rangeFrom = _isYmd(req.query.from) ? req.query.from : monthStartStr;
        let rangeTo   = _isYmd(req.query.to)   ? req.query.to   : todayStr;
        if (rangeFrom > rangeTo) { const t = rangeFrom; rangeFrom = rangeTo; rangeTo = t; }
        const _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const _fmtR = (s) => { const a = s.split('-'); return `${Number(a[2])} ${_MON[Number(a[1]) - 1]} ${a[0]}`; };
        const rangeLabel = `${_fmtR(rangeFrom)} – ${_fmtR(rangeTo)}`;

        const { body } = await api.get(req,
            '/dashboard/summary?from=' + encodeURIComponent(rangeFrom) + '&to=' + encodeURIComponent(rangeTo));
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

        // Super-admin only: prepend a platform-level "Total Licenses" card.
        // Count comes from the licenses list meta.total (accurate beyond the
        // 100 the header switcher fetches); fall back to that list's length.
        if (res.locals.isSuperAdmin) {
            let licenseCount = Array.isArray(res.locals.licenses) ? res.locals.licenses.length : 0;
            try {
                const lr = await api.get(req, '/super-admin/licenses?per_page=1');
                const meta = lr && lr.body && lr.body.data && lr.body.data.meta;
                if (meta && Number.isFinite(Number(meta.total))) licenseCount = Number(meta.total);
            } catch (_) { /* keep the fallback count */ }
            stats.unshift({ label: 'Total Licenses', value: grp(licenseCount), icon: 'fa-key', tone: 'indigo' });
        }

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

            // Date-range picker state (header pill).
            rangeFrom,
            rangeTo,
            rangeLabel,

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
        const config = await fetchConfig(req, ['financial_years']);
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
            ...config,
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
router.get('/companies/add', async (req, res, next) => {
    try {
        const config = await fetchConfig(req, ['financial_years']);
        res.render('companies/form', {
            title: 'Add Company',
            activeMenu: 'companies',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Companies', href: '/companies' },
                { label: 'Add Company' },
            ],

            // Form dropdown option sources.
            ...config,
        });
    } catch (err) { next(err); }
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
        const config = await fetchConfig(req, ['supplier_groups']);
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
            locationNames: mock.locationNames, ...config,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Supplier (GET /suppliers/add) ────────────── */
router.get('/suppliers/add', async (req, res, next) => {
    try {
        const locationOptions = await fetchOptions(req, '/locations');
        const config = await fetchConfig(req, ['supplier_groups', 'payment_terms']);
        res.render('suppliers/form', {
            title: 'Add Supplier',
            activeMenu: 'suppliers',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Suppliers', href: '/suppliers' },
                { label: 'Add Supplier' },
            ],
            locationOptions,                 // FK (id+name) for the Location select
            ...config,
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
        const config = await fetchConfig(req, ['gst_rates']);
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
            categoryNames: mock.categoryNames, ...config,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Product (GET /products/add) ──────────────── */
router.get('/products/add', async (req, res, next) => {
    try {
        const categoryOptions = await fetchOptions(req, '/categories');
        const config = await fetchConfig(req, ['units', 'gst_rates']);
        res.render('products/form', {
            title: 'Add Product',
            activeMenu: 'products',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Products', href: '/products' },
                { label: 'Add Product' },
            ],
            categoryOptions,                 // FK (id+name) for the Category select
            ...config,
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
    const config = await fetchConfig(req, ['payment_modes']);
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
        ...config,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Add Payment (GET /payments/add) ─────────── */
router.get('/payments/add', async (req, res, next) => {
    try {
        const supplierOptions = await fetchOptions(req, '/suppliers');
        const config = await fetchConfig(req, ['payment_modes']);
        res.render('payments/form', {
            title: 'Add Payment',
            activeMenu: 'payments',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Payments', href: '/payments' },
                { label: 'Add Payment' },
            ],
            supplierOptions,                 // FK (id+name) for the Supplier select
            ...config,
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
    const config = await fetchConfig(req, ['payment_modes']);
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
        ...config,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Add Receipt (GET /receipts/add) ─────────── */
router.get('/receipts/add', async (req, res, next) => {
    try {
        const customerOptions = await fetchOptions(req, '/customers');
        const config = await fetchConfig(req, ['payment_modes']);
        res.render('receipts/form', {
            title: 'Add Receipt',
            activeMenu: 'receipts',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Receipts', href: '/receipts' },
                { label: 'Add Receipt' },
            ],
            customerOptions,                 // FK (id+name) for the Customer select
            ...config,
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
        if (req.query.sort)   qs.set('sort',  String(req.query.sort));
        if (req.query.order)  qs.set('order', String(req.query.order));

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

/* Parse a human RECORD NAME out of a log message (mirrors the api's
 * recordNameFrom). Pull rows carry "Imported from Tally: X" → "X"; otherwise
 * fall back to record_type + id so the column is never blank. */
function syncRecordName(message, recordType, recordId) {
    const raw = String(message == null ? '' : message);
    const m = raw.match(/imported from tally:\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
    const rt = String(recordType || '').trim();
    const rid = recordId != null && recordId !== '' ? String(recordId) : '';
    if (rt && rid) return `${rt} #${rid}`;
    return rt || (rid ? `#${rid}` : '—');
}

/* Build the FULL Sync Dashboard view-model from /sync/summary. Shared by the
 * page render AND the JSON poller (GET /sync-dashboard.json) so the EJS-rendered
 * page and the live DOM updates share ONE contract. Returns plain JS objects
 * (no EJS) — the page route spreads these into res.render; the poller serialises
 * them straight to JSON. Every value the poller updates IN PLACE is included. */
async function buildSyncDashboardData(req) {
    const { body } = await api.get(req, '/sync/summary');
    const data    = (body && body.data) || {};
    const summary = data.summary || {};
    const stats   = data.stats   || {};
    const modules = Array.isArray(data.modules) ? data.modules : [];
    const recent  = Array.isArray(data.recent)  ? data.recent  : [];

    const connected = !!summary.connected;
    // Date AND time everywhere "Last Sync" / heartbeat is shown.
    const heartbeatTxt = summary.heartbeat_at ? fmtDateTime(summary.heartbeat_at) : '—';
    const lastSyncTxt  = summary.last_sync_at ? fmtDateTime(summary.last_sync_at) : '—';

    const totalSynced = Number(stats.total_synced) || 0;
    const failed      = Number(stats.failed) || 0;

    const syncModules = modules.map((m) => {
        const total   = Number(m.total) || 0;
        const synced  = Number(m.synced) || 0;
        const pct     = total ? Math.round((synced / total) * 100) : 0;
        return {
            key:          m.key || '',
            module:       m.label || m.module || '',
            total,
            synced,
            pending:      Number(m.pending) || 0,
            failed:       Number(m.failed) || 0,
            pct,
            last_sync:    m.last_sync_at ? fmtDateTime(m.last_sync_at) : (m.last_sync ? fmtDateTime(m.last_sync) : '—'),
        };
    });

    const recentSync = recent.map((r) => {
        const s = String(r.status || '');
        return {
            module: r.module || '',
            record: syncRecordName(r.message, r.record_type, r.record_id),
            status: s ? s.charAt(0).toUpperCase() + s.slice(1) : '',
            time:   r.created_at ? fmtDateTime(r.created_at) : '',
        };
    });

    // Auto-update surface (Requirement 3). agent_version is the installed exe;
    // latest_version the published one; update_available a server-side semver
    // compare; auto_update the per-license cloud toggle (drives the switch).
    const installedVer    = summary.agent_version || null;
    const latestVer       = summary.latest_version || null;
    const updateAvailable = !!summary.update_available;
    const mandatoryUpdate = !!summary.mandatory_update;
    const autoUpdate      = summary.auto_update !== false;   // default ON

    // Auto-sync DIRECTION toggles (Requirement 1). Per-license push/pull flags
    // the agent loop honours; default ON when absent (matches the api default).
    const pushEnabled = summary.push_enabled !== false;
    const pullEnabled = summary.pull_enabled !== false;

    return {
        connected,
        connection:    connected ? 'Connected' : 'Disconnected',
        agent_version: installedVer || '—',
        company:       summary.company || '—',
        heartbeat:     heartbeatTxt,
        last_sync:     lastSyncTxt,
        total_synced:  totalSynced,
        total_synced_fmt: totalSynced.toLocaleString('en-IN'),
        failed,
        failed_fmt:    failed.toLocaleString('en-IN'),
        modules:       syncModules,
        recent:        recentSync,
        // Version / auto-update (live-reflected by /js/sync-dashboard.js).
        latest_version:   latestVer,
        update_available: updateAvailable,
        mandatory_update: mandatoryUpdate,
        auto_update:      autoUpdate,
        release_notes:    summary.release_notes || null,
        // Auto-sync direction toggles (live-reflected by /js/sync-dashboard.js).
        push_enabled:     pushEnabled,
        pull_enabled:     pullEnabled,
    };
}

/* ── TALLY SYNC · Sync Dashboard (GET /sync-dashboard) ──────── */
router.get('/sync-dashboard', async (req, res, next) => {
    try {
        const d = await buildSyncDashboardData(req);

        // Connection banner state (same keys the view's _sum reads). Date+time.
        const syncSummary = {
            connected:      d.connected,
            agent_version:  d.agent_version,
            tally_version:  'TallyPrime',
            company:        d.company,
            last_heartbeat: d.heartbeat,
            last_sync:      d.last_sync,
            // Auto-update surface (Requirement 3).
            latest_version:   d.latest_version,
            update_available: d.update_available,
            mandatory_update: d.mandatory_update,
            auto_update:      d.auto_update,
            release_notes:    d.release_notes,
            // Auto-sync direction toggles (Requirement 1).
            push_enabled:     d.push_enabled,
            pull_enabled:     d.pull_enabled,
        };

        // Active company (header switcher) — drives the "Open in Tally" connect
        // button on the not-connected alert (Requirement 3).
        const activeCompany = res.locals.company || null;

        // Four headline stat cards — icon/tone preserved; values now date+time.
        const syncStats = [
            { label: 'Connection',           value: d.connection,       icon: 'fa-plug-circle-check',    tone: 'green'  },
            { label: 'Last Sync',            value: d.last_sync,        icon: 'fa-clock-rotate-left',    tone: 'blue'   },
            { label: 'Total Records Synced', value: d.total_synced_fmt, icon: 'fa-circle-check',         tone: 'purple' },
            { label: 'Failed Records',       value: d.failed_fmt,       icon: 'fa-triangle-exclamation', tone: 'amber'  },
        ];

        res.render('tally-sync/dashboard', {
            title: 'Sync Dashboard',
            activeMenu: 'sync-dash',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Tally Sync' },
            ],

            syncSummary,
            syncStats,
            syncModules: d.modules,
            recentSync:  d.recent,
            // Active company id+name for the "Open in Tally" connect button.
            activeCompany,

            // Live auto-refresh poller (updates the badge/stats/rows in place).
            pageScript: '<script src="/js/sync-dashboard.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── TALLY SYNC · Live poll JSON (GET /sync-dashboard.json) ────
 * Lightweight JSON variant of the dashboard data for the page's 15s poller.
 * Returns the SAME view-model the page rendered from, so the client updates the
 * connection badge/dot, stats and every module row IN PLACE with no reload. */
router.get('/sync-dashboard.json', async (req, res) => {
    try {
        const d = await buildSyncDashboardData(req);
        return res.json({ ok: true, data: d });
    } catch (err) {
        return res.status(200).json({ ok: false, error: 'sync_summary_unavailable' });
    }
});

/* ── TALLY SYNC · Retry / re-queue + 2-way manual sync (POST) ──
 * /sync-retry            → PUSH (re-queue) ALL modules
 * /sync-retry/:module    → PUSH one module (a MODULE_CATALOG key)
 * /sync-pull             → PULL (re-import) ALL modules from Tally
 * /sync-pull/:module     → PULL one module from Tally
 *
 * PUSH posts the api POST /sync/retry; PULL posts POST /sync/pull (which resets
 * the company's pull watermark so the agent re-imports). Both are MANUAL and
 * NOT gated by the per-license auto toggles. The grid's two small per-module
 * buttons + Sync-All POST here as XHR (JSON) — the JS toasts the api's msg;
 * a plain-form fallback flashes + redirects. */
async function handleSyncDirection(direction, req, res) {
    const wantJson = req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1;
    const moduleKey = req.params.module ? String(req.params.module) : '';
    const isPull = direction === 'pull';
    const path   = isPull ? '/sync/pull' : '/sync/retry';
    const body   = {};
    if (moduleKey) body.module = moduleKey;
    if (isPull) body.direction = 'pull';   // belt-and-braces (api /sync/pull is explicit)
    const fallbackOk = isPull
        ? 'Queued a fresh import from Tally.'
        : 'Re-queued records for sync.';
    const fallbackErr = isPull
        ? 'Could not queue the import from Tally.'
        : 'Could not re-queue records for sync.';
    try {
        const result = await api.post(req, path, body);
        const ok  = apiOk(result);
        const msg = (result && result.body && result.body.msg) || (ok ? fallbackOk : apiError(result, fallbackErr));
        if (wantJson) return res.status(200).json({ ok: !!ok, direction, module: moduleKey || null, msg });
        setFlash(req, ok ? 'success' : 'error', msg);
    } catch (_) {
        if (wantJson) return res.status(200).json({ ok: false, direction, module: moduleKey || null, msg: 'Could not reach the API server.' });
        setFlash(req, 'error', 'Could not reach the API server.');
    }
    const back = req.get('Referer') || '/sync-dashboard';
    return req.session.save(() => res.redirect(back));
}
function handleSyncRetry(req, res) { return handleSyncDirection('push', req, res); }
function handleSyncPull(req, res)  { return handleSyncDirection('pull', req, res); }
router.post('/sync-retry',          handleSyncRetry);
router.post('/sync-retry/:module',  handleSyncRetry);
router.post('/sync-pull',           handleSyncPull);
router.post('/sync-pull/:module',   handleSyncPull);

/* ── TALLY SYNC · Auto-sync DIRECTION toggles (POST /sync-direction) ──
 * Flips the per-license push/pull AUTO toggles via the api PATCH
 * /account/sync-direction. The dashboard's two switches submit here (a tiny JS
 * fetch, or a plain form fallback) with `push_enabled` / `pull_enabled` = on/off.
 * Each is optional; at least one is sent. The agent reads the new values back
 * via its heartbeat each cycle and skips the push/pull pass when off. Returns
 * JSON when called as XHR, else flashes + redirects back. */
router.post('/sync-direction', async (req, res) => {
    const wantJson = req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1;
    const b = (req && req.body) || {};
    const payload = {};
    // Only forward a flag the client actually sent (so toggling one switch does
    // not clobber the other). The api treats each flag as optional.
    if (b.push_enabled !== undefined) payload.push_enabled = asBool(b.push_enabled);
    if (b.pull_enabled !== undefined) payload.pull_enabled = asBool(b.pull_enabled);
    try {
        const result = await api.patch(req, '/account/sync-direction', payload);
        const ok  = apiOk(result) || (result && result.body && result.body.status === 200);
        const data = (result && result.body && result.body.data) || {};
        const msg = (result && result.body && result.body.msg)
            || (ok ? 'Auto-sync direction updated.' : apiError(result, 'Could not change auto-sync direction.'));
        if (wantJson) {
            return res.status(200).json({
                ok: !!ok, msg,
                push_enabled: data.push_enabled, pull_enabled: data.pull_enabled,
            });
        }
        setFlash(req, ok ? 'success' : 'error', msg);
    } catch (_) {
        if (wantJson) return res.status(200).json({ ok: false, msg: 'Could not reach the API server.' });
        setFlash(req, 'error', 'Could not reach the API server.');
    }
    const back = req.get('Referer') || '/sync-dashboard';
    return req.session.save(() => res.redirect(back));
});

/* ── TALLY SYNC · Agent auto-update toggle (POST /sync-auto-update) ──
 * Flips the per-license cloud auto-update toggle via the api PATCH
 * /account/agent/auto-update. The dashboard switch submits here (a tiny JS
 * fetch, or a plain form fallback) with `enabled` = on/off. The agent reads the
 * new value as authoritative on its next /agent/version check. Returns JSON when
 * called as XHR, else flashes + redirects back. */
router.post('/sync-auto-update', async (req, res) => {
    const wantJson = req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1;
    const enabled = asBool(req.body && req.body.enabled);
    try {
        const result = await api.patch(req, '/account/agent/auto-update', { enabled });
        const ok  = apiOk(result) || (result && result.body && result.body.status === 200);
        const msg = (result && result.body && result.body.msg)
            || (ok ? (enabled ? 'Auto-update turned ON.' : 'Auto-update turned OFF.')
                   : apiError(result, 'Could not change auto-update.'));
        if (wantJson) {
            return res.status(200).json({ ok: !!ok, enabled, msg });
        }
        setFlash(req, ok ? 'success' : 'error', msg);
    } catch (_) {
        if (wantJson) return res.status(200).json({ ok: false, enabled, msg: 'Could not reach the API server.' });
        setFlash(req, 'error', 'Could not reach the API server.');
    }
    const back = req.get('Referer') || '/sync-dashboard';
    return req.session.save(() => res.redirect(back));
});

/* ── TALLY SYNC · Update agent now (POST /sync-update-now) ─────
 * Enqueues a 'self_update' agent command (api POST /account/agent/self-update)
 * so the agent forces an update check on its next poll. The agent self-updates,
 * so this just confirms "will update within a minute". JSON for the button's
 * fetch; flash+redirect fallback otherwise. */
router.post('/sync-update-now', async (req, res) => {
    const wantJson = req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1;
    try {
        const result = await api.post(req, '/account/agent/self-update', {});
        const bodyStatus = result && result.body && result.body.status;
        const ok  = bodyStatus && bodyStatus >= 200 && bodyStatus < 300;
        const msg = (result && result.body && result.body.msg)
            || (ok ? 'Update requested. The agent will update within a minute.'
                   : apiError(result, 'Could not request an update.'));
        if (wantJson) return res.status(200).json({ ok: !!ok, msg });
        setFlash(req, ok ? 'success' : 'error', msg);
    } catch (_) {
        if (wantJson) return res.status(200).json({ ok: false, msg: 'Could not reach the API server.' });
        setFlash(req, 'error', 'Could not reach the API server.');
    }
    const back = req.get('Referer') || '/sync-dashboard';
    return req.session.save(() => res.redirect(back));
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

        // Map api columns → the view's expected keys. For each row we also
        // compute the FRIENDLY reason + fix from the raw Tally message so the
        // view shows a plain-language cause/fix on failures (not just the raw
        // message). `failed` flags the row so the view can style + show the fix.
        const logRows = rows.map((r) => {
            const isFailed = String(r.status || '').toLowerCase() === 'failed';
            const fr = friendlyReason(r.message, r.status);
            return {
                id:        r.id,
                module:    r.module || '',
                // Clear RECORD name/description (parsed from the message, else
                // record_type + id) so the column reads like "Acme Traders"
                // not just a bare id.
                record:    syncRecordName(r.message, r.record_type, r.record_id),
                direction: r.direction || '',
                status:    txStatusLabel(r.status),
                // On failures show the friendly cause in the Message column;
                // success rows keep their (short) raw note.
                message:   isFailed ? fr.cause : (r.message || ''),
                reason:    fr.cause,
                fix:       fr.fix,
                raw:       r.message || '',
                failed:    isFailed,
                time:      fmtDateTime(r.synced_at || r.created_at),
            };
        });

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

            // "Common fixes / How to restart" help panel content.
            restartHelp: RESTART_HELP,

            // Filter dropdown option sources (still mock — api doesn't provide them).
            syncModuleNames: mock.syncModuleNames,
            syncDirections:  mock.syncDirections,
            syncLogStatuses: mock.syncLogStatuses,

            // Log-detail popup behaviour (opens the modal on the per-row view btn).
            pageScript: '<script src="/js/sync-logs.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── TALLY SYNC · Single log detail (GET /sync-logs/:id) ──────
 * JSON consumed by /js/sync-logs.js to fill + show the detail modal. Proxies
 * the api GET /sync/logs/:id (company-scoped) and formats the timestamps to
 * date+time. Returns plain JSON (not an EJS render). */
router.get('/sync-logs/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(200).json({ ok: false, error: 'bad_id' });
        }
        const { body } = await api.get(req, `/sync/logs/${id}`);
        if (!apiOk({ body })) {
            return res.status(200).json({ ok: false, error: (body && body.msg) || 'not_found' });
        }
        const d = (body && body.data) || {};
        return res.json({
            ok: true,
            data: {
                id:           d.id,
                module:       d.module || '',
                record_type:  d.record_type || '',
                record_id:    d.record_id != null ? d.record_id : '',
                record_name:  d.record_name || '',
                direction:    d.direction || '',
                status:       txStatusLabel(d.status),
                status_raw:   d.status || '',
                reason:       (d.reason && d.reason.cause) || '',
                fix:          (d.reason && d.reason.fix) || '',
                severity:     (d.reason && d.reason.severity) || '',
                message:      d.message || '',
                request_xml:  d.request_xml || '',
                response_xml: d.response_xml || '',
                retry_count:  d.retry_count != null ? d.retry_count : 0,
                created_at:   d.created_at ? fmtDateTime(d.created_at) : '—',
                synced_at:    d.synced_at ? fmtDateTime(d.synced_at) : '—',
            },
        });
    } catch (_) {
        return res.status(200).json({ ok: false, error: 'unavailable' });
    }
});

/* ── CHANGE HISTORY · History page (GET /history) ───────────────
 * Lists recent per-record changes across every module (filterable by module /
 * action / source / search), each row showing module, record, action,
 * who/when and a "what changed" summary, with View/Revert actions. Proxies the
 * api GET /history (company-scoped). */
const HISTORY_MODULE_LABELS = {
    customers: 'Customers', suppliers: 'Suppliers', products: 'Products',
    categories: 'Categories', locations: 'Locations', 'sales-persons': 'Sales Persons',
    'customer-groups': 'Customer Groups', 'sales-invoices': 'Sales Invoices',
    'purchase-invoices': 'Purchase Invoices', payments: 'Payments',
    receipts: 'Receipts', journals: 'Journals',
};
function historyModuleLabel(slug) {
    return HISTORY_MODULE_LABELS[slug] || (slug ? String(slug) : '');
}
/* action → human label + the pill class the table understands (created/synced
 * → success-ish, deleted → danger, updated → info-ish, reverted → warning). */
function historyActionLabel(a) {
    const map = { created: 'Created', updated: 'Updated', deleted: 'Deleted',
        synced: 'Synced', reverted: 'Reverted' };
    return map[String(a || '').toLowerCase()] || a || '';
}

router.get('/history', async (req, res, next) => {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = parseInt(req.query.per_page, 10) || 10;
        const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
        if (req.query.module)    qs.set('module',    String(req.query.module));
        if (req.query.action)    qs.set('action',    String(req.query.action));
        if (req.query.source)    qs.set('source',    String(req.query.source));
        if (req.query.record_id) qs.set('record_id', String(req.query.record_id));
        if (req.query.search)    qs.set('search',    String(req.query.search));

        const { body } = await api.get(req, `/history?${qs.toString()}`);
        const payload  = (body && body.data) || {};
        const rows     = Array.isArray(payload.data) ? payload.data : [];
        const meta     = payload.meta || { total: rows.length, page, per_page: perPage };

        const historyRows = rows.map((r) => ({
            id:       r.id,
            module:   historyModuleLabel(r.module),
            record:   r.record_label || (r.record_id != null ? `#${r.record_id}` : '—'),
            action:   historyActionLabel(r.action),
            source:   r.source || '',
            who:      r.changed_by_name || (r.source === 'tally' ? 'Tally Sync' : (r.source || 'System')),
            changed:  r.summary || '',
            time:     fmtDateTime(r.created_at),
            // raw module slug + record id so the Revert form posts/back-links right.
            module_slug: r.module || '',
            record_id:   r.record_id != null ? r.record_id : '',
        }));

        res.render('history/index', {
            title: 'Change History',
            activeMenu: 'history',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Change History' }],
            historyRows,
            historyTotal: meta.total != null ? meta.total : historyRows.length,
            page:    meta.page    != null ? meta.page    : page,
            perPage: meta.per_page != null ? meta.per_page : perPage,
            // Filter dropdown option sources.
            historyModules: Object.keys(HISTORY_MODULE_LABELS).map((k) => ({ value: k, label: HISTORY_MODULE_LABELS[k] })),
            historyActions: ['created', 'updated', 'deleted', 'synced', 'reverted'],
            historySources: ['cloud', 'tally', 'agent', 'system'],
            pageScript: '<script src="/js/history.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── CHANGE HISTORY · Detail JSON (GET /history/:id) ────────────
 * JSON consumed by /js/history.js to fill + show the detail modal: the full
 * before/after objects, the changed-fields list, and the per-record compare
 * snapshots (fetched in the same request so the modal shows the timeline). */
router.get('/history/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(200).json({ ok: false, error: 'bad_id' });
        }
        const { body } = await api.get(req, `/history/${id}`);
        if (!apiOk({ body })) {
            return res.status(200).json({ ok: false, error: (body && body.msg) || 'not_found' });
        }
        const d = (body && body.data) || {};

        // Pull the per-record compare timeline too (best-effort) so the modal can
        // render "value on each date" side-by-side. Needs module + record_id.
        let compare = null;
        if (d.module && d.record_id != null && d.record_id !== '') {
            try {
                const cq = new URLSearchParams({ module: String(d.module), record_id: String(d.record_id) });
                const cr = await api.get(req, `/history/compare?${cq.toString()}`);
                if (apiOk(cr) && cr.body && cr.body.data) compare = cr.body.data;
            } catch (_) { compare = null; }
        }

        return res.json({
            ok: true,
            data: {
                id:             d.id,
                module:         historyModuleLabel(d.module),
                module_slug:    d.module || '',
                record_type:    d.record_type || '',
                record_id:      d.record_id != null ? d.record_id : '',
                record_label:   d.record_label || '',
                action:         historyActionLabel(d.action),
                action_raw:     d.action || '',
                source:         d.source || '',
                who:            d.changed_by_name || (d.source === 'tally' ? 'Tally Sync' : (d.source || 'System')),
                summary:        d.summary || '',
                note:           d.note || '',
                before:         d.before || null,
                after:          d.after || null,
                changed_fields: Array.isArray(d.changed_fields) ? d.changed_fields : [],
                created_at:     d.created_at ? fmtDateTime(d.created_at) : '—',
                // Can this entry be reverted? Only when it has a before snapshot.
                revertable:     !!(d.before && typeof d.before === 'object'),
                compare,
            },
        });
    } catch (_) {
        return res.status(200).json({ ok: false, error: 'unavailable' });
    }
});

/* ── CHANGE HISTORY · Revert (POST /history/:id/revert) ─────────
 * Calls the api revert (cloud-side), flashes the api's message and bounces back
 * to the History page. */
router.post('/history/:id/revert', async (req, res) => {
    const id   = Number(req.params.id);
    const back = req.get('Referer') || '/history';
    if (!Number.isInteger(id) || id <= 0) {
        setFlash(req, 'error', 'Invalid history entry.');
        return req.session.save(() => res.redirect(back));
    }
    try {
        const result = await api.post(req, `/history/${id}/revert`, {});
        if (apiOk(result)) {
            setFlash(req, 'success', (result.body && result.body.msg) || 'Record reverted (cloud copy).');
        } else {
            setFlash(req, 'error', apiError(result, 'Could not revert the record.'));
        }
    } catch (_) {
        setFlash(req, 'error', 'Could not reach the API server.');
    }
    return req.session.save(() => res.redirect(back));
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
        if (req.query.sort)        qs.set('sort',  String(req.query.sort));
        if (req.query.order)       qs.set('order', String(req.query.order));

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
        // Role options = the roles VISIBLE to this admin (system company-admin
        // role + their license custom roles like "Salesman"). Location options =
        // the company's real locations (id+name) so the form submits a real
        // location_id; blank = all locations (no per-user location restriction).
        const [roleOptions, locationOptions] = await Promise.all([
            fetchOptions(req, '/roles'),
            fetchOptions(req, '/locations'),
        ]);
        res.render('users/form', {
            title: 'Add User',
            activeMenu: 'users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Users', href: '/users' },
                { label: 'Add User' },
            ],
            roleOptions,
            locationOptions,
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
        const config = await fetchConfig(req, ['financial_years', 'gst_rates', 'payment_terms']);

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

            // Config-enumeration option sources (api single source /config/options).
            ...config,
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
        const config   = await fetchConfig(req, ['customer_groups']);

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
            ...config,
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
        const config = await fetchConfig(req, ['supplier_groups', 'payment_terms']);
        res.render('suppliers/form', {
            title: 'Edit Supplier', activeMenu: 'suppliers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Suppliers', href: '/suppliers' }, { label: 'Edit Supplier' }],
            record, locationOptions, ...config,
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
        const config = await fetchConfig(req, ['units', 'gst_rates']);
        res.render('products/form', {
            title: 'Edit Product', activeMenu: 'products',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Products', href: '/products' }, { label: 'Edit Product' }],
            record, categoryOptions, ...config,
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

/* ── PLATFORM ADMIN · Licenses (super-admin only) ────────────────
 * Cross-tenant licence management. Each route is gated by requireSuperAdmin
 * (the api also enforces super-admin, but we block here so nothing leaks).
 * The one-time license_key + auto-generated admin password are revealed on a
 * rendered success screen and are NEVER stored in the session/db/logs. */

/* GET /licenses — paginated cross-tenant licence list. */
router.get('/licenses', requireSuperAdmin, async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/super-admin/licenses');
        const licenseRows = rows.map((r) => ({
            id:               r.id,
            holder_name:      r.holder_name || '',
            key_prefix:       r.key_prefix ? (String(r.key_prefix).replace(/[-\s]*$/, '') + '-…') : '—',
            plan:             r.plan || 'standard',
            companies_count:  r.companies_count != null ? r.companies_count : 0,
            max_companies:    r.max_companies != null ? r.max_companies : 0,
            max_users:        r.max_users != null ? r.max_users : 0,
            status:           r.status || '',
            status_label:     r.status === 'suspended' ? 'Suspended' : (r.status === 'active' ? 'Active' : (r.status || '')),
            valid_until:      r.valid_until ? fmtDate(r.valid_until) : '',
            machine_bound:    !!(r.machine_id || r.machine_bound_at),
            last_seen_at:     r.last_seen_at ? fmtDate(r.last_seen_at) : '',
        }));
        res.render('licenses/list', {
            title: 'Licenses',
            activeMenu: 'licenses',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Licenses' }],
            licenseRows, licensesTotal: meta.total, page: meta.page, perPage: meta.per_page,
        });
    } catch (err) { next(err); }
});

/* GET /licenses/register — empty Register form. */
router.get('/licenses/register', requireSuperAdmin, (req, res) => {
    res.render('licenses/form', {
        title: 'Register License',
        activeMenu: 'licenses',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Licenses', href: '/licenses' },
            { label: 'Register License' },
        ],
        error: null,
        old: {},
    });
});

/* POST /licenses — register a licence (api also creates its default admin).
 * On success render the ONE-TIME reveal screen with the api data (NO redirect,
 * NO session/db/log persistence of the key/password). On error re-render the
 * form with the message + the entered values so nothing is lost. */
router.post('/licenses', requireSuperAdmin, async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            holder_name:   b.holder_name,
            tally_serial:  b.tally_serial || undefined,
            plan:          b.plan || 'standard',
            max_companies: num(b.max_companies),
            max_users:     num(b.max_users),
            valid_until:   b.valid_until || undefined,
            admin_email:   b.admin_email,
            admin_name:    b.admin_name || undefined,
            admin_mobile:  b.admin_mobile || undefined,
            admin_password: b.admin_password || undefined,
        };
        const result = await api.post(req, '/super-admin/licenses', payload);
        if (apiOk(result)) {
            const data  = (result.body && result.body.data) || {};
            const login = data.admin_login || {};
            // Render the one-time reveal directly from the response. These
            // secrets are intentionally NOT written to the session/db/logs.
            return res.render('licenses/created', {
                title: 'License Created',
                activeMenu: 'licenses',
                breadcrumb: [
                    { label: 'Dashboard', href: '/' },
                    { label: 'Licenses', href: '/licenses' },
                    { label: 'License Created' },
                ],
                licenseKey:    data.license_key || '',
                adminEmail:    login.email || payload.admin_email || '',
                adminPassword: login.password || '',   // present only when auto-generated
                license:       data.license || {},
            });
        }
        // Re-render the form with the error + the entered values (input survives).
        return res.status(200).render('licenses/form', {
            title: 'Register License',
            activeMenu: 'licenses',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Licenses', href: '/licenses' },
                { label: 'Register License' },
            ],
            error: apiError(result, 'Could not register the license.'),
            old: {
                holder_name: b.holder_name, tally_serial: b.tally_serial, plan: b.plan,
                max_companies: b.max_companies, max_users: b.max_users, valid_until: b.valid_until,
                admin_email: b.admin_email, admin_name: b.admin_name, admin_mobile: b.admin_mobile,
                // NOTE: admin_password is intentionally NOT echoed back.
            },
        });
    } catch (err) { next(err); }
});

/* Shared handler for the licence state-change actions (suspend / activate /
 * reset-machine). Calls the matching api endpoint, flashes, returns to list. */
function licenseAction(apiPath, okMsg, failMsg) {
    return async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const result = await api.post(req, `/super-admin/licenses/${id}/${apiPath}`, {});
            if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || okMsg);
            else setFlash(req, 'error', apiError(result, failMsg));
            return req.session.save(() => res.redirect('/licenses'));
        } catch (err) { next(err); }
    };
}
router.post('/licenses/:id/suspend',       requireSuperAdmin, licenseAction('suspend',       'License suspended.',        'Could not suspend the license.'));
router.post('/licenses/:id/activate',      requireSuperAdmin, licenseAction('activate',      'License reactivated.',      'Could not activate the license.'));
router.post('/licenses/:id/reset-machine', requireSuperAdmin, licenseAction('reset-machine', 'Agent machine unbound.',    'Could not reset the machine.'));

/* ── PLATFORM ADMIN · License Modules / entitlements (super-admin only) ──────
 * Which modules a license's roles MAY use. The api returns a module × action
 * matrix with the currently-granted cells; an empty grant set (all_granted)
 * means the license is implicitly entitled to EVERYTHING until restricted. */

/* GET /licenses/:id/permissions — render the entitlement grid for one license. */
router.get('/licenses/:id/permissions', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { body } = await api.get(req, `/super-admin/licenses/${id}/permissions`);
        const data = (body && body.data) || {};
        res.render('licenses/permissions', {
            title: 'License Modules',
            activeMenu: 'licenses',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Licenses', href: '/licenses' },
                { label: 'Modules' },
            ],
            license:    data.license || { id },
            modules:    Array.isArray(data.modules) ? data.modules : [],
            actions:    Array.isArray(data.actions) ? data.actions : ['view', 'create', 'edit', 'delete', 'export'],
            granted:    data.granted || {},
            allGranted: !!data.all_granted,
        });
    } catch (err) { next(err); }
});

/* POST /licenses/:id/permissions — save the ticked module×action entitlements.
 * Browsers can't PUT from a form, so we proxy to api.put. The checkbox grid
 * submits `perm` = '<module>.<action>' (a single box arrives as a string, many
 * as an array), so [].concat(...) normalises it to a slugs array. */
router.post('/licenses/:id/permissions', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const slugs = [].concat(req.body.perm || []);
        const result = await api.put(req, `/super-admin/licenses/${id}/permissions`, { slugs });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Module entitlements saved.');
        else setFlash(req, 'error', apiError(result, 'Could not save module entitlements.'));
        return req.session.save(() => res.redirect('/licenses'));
    } catch (err) { next(err); }
});

/* ── SETTINGS · Roles (license-admin / tenant; company-admin only) ───────────
 * Custom role management, license-scoped. The permission grids are ALWAYS built
 * from the license's entitlements (GET /account/roles/available-permissions),
 * never a hardcoded module list. The api enforces can('users',*) too. WEB paths
 * use /roles-admin (NOT /roles) to avoid colliding with the Phase-1 RBAC demo. */

/* Turn a permissions array (['mod.action', …]) into a quick-lookup set for the
 * grid's pre-check. */
function permsToSet(list) {
    const out = {};
    (Array.isArray(list) ? list : []).forEach((s) => { if (s) out[String(s)] = true; });
    return out;
}

/* GET /roles-admin — list this license's roles (system + custom). */
router.get('/roles-admin', requireRoleManager, async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/account/roles');
        // The api wraps the list in { data:[...], meta } under body.data (the
        // standard LIST envelope), so read body.data.data. Stay defensive in
        // case body.data is ever a plain array.
        const payload = (body && body.data) || {};
        const rows = Array.isArray(payload) ? payload
            : (Array.isArray(payload.data) ? payload.data : []);
        const roleRows = rows.map((r) => ({
            id:         r.id,
            name:       r.name || '',
            slug:       r.slug || '',
            is_system:  !!r.is_system,
            editable:   !!r.editable,
            user_count: r.user_count != null ? Number(r.user_count) : 0,
        }));
        res.render('roles/list', {
            title: 'Roles',
            activeMenu: 'roles-admin',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Roles' }],
            roleRows,
        });
    } catch (err) { next(err); }
});

/* GET /roles-admin/new — empty create form, grid built from entitlements.
 * Super-admin: when a license is selected in the header switcher, scope the
 * permission grid to THAT license's entitlements (pass ?license_id); otherwise
 * the api returns the full catalogue for a global template role. */
router.get('/roles-admin/new', requireRoleManager, async (req, res, next) => {
    try {
        const isSuper = req.session && req.session.user && req.session.user.role_slug === 'super-admin';
        const licId   = isSuper && req.session.licenseId ? Number(req.session.licenseId) : null;
        const permsPath = '/account/roles/available-permissions'
            + (licId ? `?license_id=${licId}` : '');
        const { body } = await api.get(req, permsPath);
        const data = (body && body.data) || {};
        res.render('roles/form', {
            title: 'New Role',
            activeMenu: 'roles-admin',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Roles', href: '/roles-admin' },
                { label: 'New Role' },
            ],
            mode: 'create',
            editable: true,
            role: {},
            modules: Array.isArray(data.modules) ? data.modules : [],
            permsSet: {},
        });
    } catch (err) { next(err); }
});

/* GET /roles-admin/:id — edit form (or read-only view for system roles),
 * pre-filled from the role's current permissions. Grid built from entitlements. */
router.get('/roles-admin/:id', requireRoleManager, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        // Fetch the role first so a super-admin can scope the permission grid to
        // the role's OWN license entitlements (a license-scoped role) or the full
        // catalogue (a global template, license_id null).
        const roleRes  = await api.get(req, `/account/roles/${id}`);
        const role     = (roleRes.body && roleRes.body.data) || { id };
        const isSuper  = req.session && req.session.user && req.session.user.role_slug === 'super-admin';
        const licId    = (isSuper && role.license_id) ? Number(role.license_id) : null;
        const permsPath = '/account/roles/available-permissions'
            + (licId ? `?license_id=${licId}` : '');
        const permsRes = await api.get(req, permsPath);
        const permsData = (permsRes.body && permsRes.body.data) || {};
        const editable  = !!role.editable;
        res.render('roles/form', {
            title: editable ? 'Edit Role' : 'View Role',
            activeMenu: 'roles-admin',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Roles', href: '/roles-admin' },
                { label: editable ? 'Edit Role' : 'View Role' },
            ],
            mode: 'edit',
            editable,
            role,
            modules: Array.isArray(permsData.modules) ? permsData.modules : [],
            permsSet: permsToSet(role.permissions),
        });
    } catch (err) { next(err); }
});

/* POST /roles-admin — create a custom role with the ticked permissions.
 * Super-admin: attach the selected license (header switcher) so the new role is
 * scoped to it; with no license selected the api creates a global TEMPLATE role
 * (license_id null). License-admins: the api uses their own license (the
 * body.license_id is ignored for non-super callers). */
router.post('/roles-admin', requireRoleManager, async (req, res, next) => {
    try {
        const slugs = [].concat(req.body.perm || []);
        const isSuper = req.session && req.session.user && req.session.user.role_slug === 'super-admin';
        const payload = { name: req.body.name, slugs };
        if (isSuper && req.session.licenseId) payload.license_id = Number(req.session.licenseId);
        const result = await api.post(req, '/account/roles', payload);
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Role created successfully.');
        else setFlash(req, 'error', apiError(result, 'Could not create the role.'));
        return req.session.save(() => res.redirect('/roles-admin'));
    } catch (err) { next(err); }
});

/* POST /roles-admin/:id — save a custom role: rename, then set its permissions.
 * Browsers can't PUT from a form, so we proxy to api.put for both calls. If the
 * rename fails we surface that and skip the permissions update. */
router.post('/roles-admin/:id', requireRoleManager, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const slugs = [].concat(req.body.perm || []);
        const renameRes = await api.put(req, `/account/roles/${id}`, { name: req.body.name });
        if (!apiOk(renameRes)) {
            setFlash(req, 'error', apiError(renameRes, 'Could not save the role.'));
            return req.session.save(() => res.redirect('/roles-admin'));
        }
        const permsRes = await api.put(req, `/account/roles/${id}/permissions`, { slugs });
        if (apiOk(permsRes)) setFlash(req, 'success', (permsRes.body && permsRes.body.msg) || 'Role saved successfully.');
        else setFlash(req, 'error', apiError(permsRes, 'Role renamed, but its permissions could not be saved.'));
        return req.session.save(() => res.redirect('/roles-admin'));
    } catch (err) { next(err); }
});

/* POST /roles-admin/:id/delete — delete a custom role (api returns 422 with a
 * message when the role is still assigned to users; surface that message). */
router.post('/roles-admin/:id/delete', requireRoleManager, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.del(req, `/account/roles/${id}`);
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Role deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the role.'));
        return req.session.save(() => res.redirect('/roles-admin'));
    } catch (err) { next(err); }
});

/* ── PLATFORM ADMIN · User Approvals (super-admin only) ──────────
 * A company-admin creates users who are PENDING and cannot sign in until the
 * platform super-admin approves them here (approval = a paid seat, capped by
 * the license max_users) or rejects them. Every route is gated by the SAME
 * requireSuperAdmin guard the licence screens use (the api also enforces it,
 * but we block here so the routes/menu never leak). */

/* GET /user-approvals — paginated cross-tenant list of PENDING users. */
router.get('/user-approvals', requireSuperAdmin, async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/super-admin/users/pending');
        const approvalRows = rows.map((r) => {
            const used = r.license_used_seats != null ? Number(r.license_used_seats) : 0;
            const max  = r.license_max_users  != null ? Number(r.license_max_users)  : 0;
            return {
                id:                 r.id,
                name:               r.name || '',
                email:              r.email || '',
                mobile:             r.mobile || '',
                role:               r.role || '',
                // company is null when the user spans all companies under the license.
                company:            r.company || '— (all companies)',
                license_holder:     r.license_holder || '—',
                license_used_seats: used,
                license_max_users:  max,
                // Subtle warning pill when the license has no free seats left.
                seats_full:         max > 0 && used >= max,
                created_at:         r.created_at ? fmtDate(r.created_at) : '—',
            };
        });
        res.render('users/approvals', {
            title: 'User Approvals',
            activeMenu: 'user-approvals',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'User Approvals' }],
            approvalRows, approvalsTotal: meta.total, page: meta.page, perPage: meta.per_page,
        });
    } catch (err) { next(err); }
});

/* POST /user-approvals/:id/approve — provision a paid seat (capped by the
 * license). On success flash body.msg; on the 422 seat-cap failure flash the
 * api's seat-cap message. Always return to the list. */
router.post('/user-approvals/:id/approve', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.post(req, `/super-admin/users/${id}/approve`, {});
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'User approved. They can now sign in.');
        else setFlash(req, 'error', apiError(result, 'Could not approve the user.'));
        return req.session.save(() => res.redirect('/user-approvals'));
    } catch (err) { next(err); }
});

/* POST /user-approvals/:id/reject — reject a pending user request. */
router.post('/user-approvals/:id/reject', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.post(req, `/super-admin/users/${id}/reject`, {});
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'User request rejected.');
        else setFlash(req, 'error', apiError(result, 'Could not reject the user.'));
        return req.session.save(() => res.redirect('/user-approvals'));
    } catch (err) { next(err); }
});

module.exports = router;
