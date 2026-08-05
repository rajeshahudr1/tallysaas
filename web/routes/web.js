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

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const FormData = require('form-data');
const mock     = require('../data/mock');
const api      = require('../Helpers/apiClient');
const { requireAuth } = require('../Middlewares/sessionGuard');
const AuthController   = require('../Controllers/AuthController');
const { friendlyReason, RESTART_HELP } = require('../Helpers/syncReason');
const { buildRanges, resolveRange, DEFAULT_RANGE } = require('../lib/date-ranges');
const { GST_STATES, GST_REGISTRATION_TYPES } = require('../../api/config/gstStates');

// Multipart receiver for the Agent-Updates upload (the exe is held in memory,
// then streamed on to the api). 200MB cap mirrors the api's own limit; a single
// "file" field only. The web→api forward re-streams the Buffer via form-data.
const agentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
}).single('file');

// Multipart receiver for the product-image gallery: up to 8 images held in
// memory, then re-streamed on to the api as multipart (field `images`). 5MB per
// file mirrors the api's own multer cap; only image mimetypes pass the filter.
const PRODUCT_IMG_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const productImgUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 8 },
    fileFilter: (req, file, cb) => cb(null, PRODUCT_IMG_MIMES.has(file.mimetype)),
}).array('images', 8);

/* ── Public auth routes (NO guard) ──────────────────────────── */
router.get('/login',  AuthController.showLogin);
router.post('/login', AuthController.login);
router.get('/forgot-password',  AuthController.showForgot);
router.post('/forgot-password', AuthController.forgot);
router.post('/reset-password',  AuthController.reset);
router.get('/logout', AuthController.logout);

/* ── Connected computers ────────────────────────────────────────
 * Which machines can reach these books, and how to cut one off. The page a
 * customer opens after a back-office PC goes missing, so listing is read-only
 * and the one destructive action is a single explicit button.
 */
router.get('/tally-sync/devices', async (req, res, next) => {
    try {
        const r = await api.get(req, '/devices');
        const d = (r.body && r.body.data) || {};
        const devices = (d.devices || []).map((x) => ({
            ...x,
            // Formatted here rather than in the template so the view stays
            // presentation-only and every screen shows dates the same way.
            last_seen_fmt: x.last_seen_at ? fmtDateTime(x.last_seen_at) : '',
            activated_fmt: x.activated_at ? fmtDateTime(x.activated_at) : '',
            revoked_fmt:   x.revoked_at   ? fmtDateTime(x.revoked_at)   : '',
        }));
        res.render('tally-sync/devices', {
            title: 'Connected computers',
            activeMenu: 'sync-dash',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Tally Sync', href: '/tally-sync' },
                { label: 'Computers' },
            ],
            devices,
            active_count: d.active_count || 0,
            online_count: d.online_count || 0,
        });
    } catch (err) { next(err); }
});

/* Disconnect one computer. POST because it changes state — a GET would let a
 * stray link or a prefetch cut a customer's sync. */
router.post('/tally-sync/devices/:id/revoke', async (req, res) => {
    try {
        const r = await api.post(req, `/devices/${encodeURIComponent(req.params.id)}/revoke`, {});
        const body = r.body || {};
        // The API's own message is passed through: it knows whether the device
        // was disconnected now or already was.
        return res.status(body.status === 200 ? 200 : 400).json(body);
    } catch (err) {
        return res.status(500).json({ msg: 'Could not disconnect that computer.' });
    }
});

/* ── The desktop agent's window ─────────────────────────────────
 * The Windows app is a shell around a WebView pointed here, so the agent's
 * entire interface lives in this repo and changes on deploy — no rebuilt exe,
 * no download for the customer.
 *
 * PUBLIC BY NECESSITY, and safe to be: the page holds no data of its own. It
 * signs in against the API like any client, and everything about the machine
 * comes from a loopback bridge that only the shell that started it can reach
 * (per-run token, in the URL fragment). Opened in an ordinary browser tab it
 * simply reports that it is not connected to the app.
 *
 * layout:false — this is an application window, not a page inside the web app,
 * so it must not inherit the site chrome.
 */
router.get('/agent-app', (req, res) => {
    res.render('agent-app/index', {
        layout: false,
        // The agent signs in against the API directly, so the page needs to
        // know where that is. Same env var the server-side apiClient reads, so
        // the two can never point at different backends.
        apiBase: (process.env.API_URL || 'http://localhost:4500/api/v1').replace(/\/$/, ''),
    });
});

/* Everything below this line requires a logged-in session. */

/* ── My Profile — available to EVERY role. Shows identity (name/email/role/
 *    mobile) + a Change Password form. GET reads the session user + /me. ── */
router.get('/profile', async (req, res, next) => {
    try {
        let me = null;
        try { const r = await api.get(req, '/me'); me = (r.body && r.body.data) || null; } catch (_) { /* fall back to session */ }
        const u = (req.session && req.session.user) || {};
        const profile = {
            name:   (me && me.name)  || u.name  || 'User',
            email:  (me && me.email) || u.email || '',
            mobile: (me && me.mobile) || u.mobile || '',
            role:   (me && me.role && me.role.name) || u.role || u.role_slug || '',
            status: (me && me.status) || '',
            last_login_at: me && me.last_login_at,
        };
        res.render('profile/index', {
            title: 'My Profile',
            activeMenu: '',
            breadcrumb: [{ label: 'My Profile' }],
            profile,
        });
    } catch (err) { next(err); }
});

/* POST /profile/change-password — proxy to the api (self password change). */
router.post('/profile/change-password', async (req, res, next) => {
    try {
        const b = req.body || {};
        if (String(b.new_password || '') !== String(b.confirm_password || '')) {
            setFlash(req, 'error', 'The new password and confirmation do not match.');
            return req.session.save(() => res.redirect('/profile'));
        }
        const result = await api.post(req, '/account/change-password', {
            current_password: b.current_password,
            new_password:     b.new_password,
        });
        setFlash(req, apiOk(result) ? 'success' : 'error',
            apiOk(result) ? ((result.body && result.body.msg) || 'Your password has been changed.')
                          : apiError(result, 'Could not change your password.'));
        return req.session.save(() => res.redirect('/profile'));
    } catch (err) { next(err); }
});
router.use(requireAuth);

/* ── RBAC route guard ───────────────────────────────────────────
 * Stops a hand-typed URL from reaching a module the user's role does not
 * grant (the sidebar + dashboard already HIDE such modules; this is the
 * matching gate so the page itself is blocked too). Maps the first path
 * segment → module and checks res.locals.canModule() (set in index.js).
 * Tally-Sync screens are company-admin-only per spec. The api ALSO enforces
 * can() on its data routes — this just renders a friendly Forbidden instead
 * of surfacing a raw 403 from the proxied call. */
// Path → module map lives in a shared module so index.js's canPath() view helper
// (which HIDES buttons) and this guard (which BLOCKS URLs) never drift apart.
const RBAC_MODULE_BY_PATH = require('../config/rbacPaths').PATH_TO_MODULE;
const RBAC_ADMIN_ONLY_PATH = new Set(['sync-dashboard', 'sync-logs', 'history']);
router.use((req, res, next) => {
    const parts = req.path.split('/').filter(Boolean);
    const seg = (parts[0] || '').toLowerCase();
    if (!seg) return next();                                   // '/' dashboard
    const isAdmin = res.locals.isSuperAdmin || res.locals.isCompanyAdmin;
    const forbid = () => {
        if (req.xhr || (req.headers.accept || '').indexOf('application/json') !== -1) {
            return res.status(403).json({ status: 403, show: true, msg: 'You do not have access to this section.' });
        }
        return res.status(403).render('errors/404', {
            title: 'Forbidden',
            activeMenu: '',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Forbidden' }],
        });
    };
    if (RBAC_ADMIN_ONLY_PATH.has(seg)) return isAdmin ? next() : forbid();
    const mod = RBAC_MODULE_BY_PATH[seg];
    // Customer-portal login: being the LINKED customer entitles them to READ
    // their scoped catalog pages even when the role carries no products/
    // categories grant (mirrors the API's canProductRead/canRefRead). Writes
    // (add/edit/delete tails) still fall through to the strict action gate.
    if (res.locals.isCustomerUser && req.method === 'GET'
        && (seg === 'products' || seg === 'categories')
        && parts.length === 1) {
        return next();
    }
    if (mod && typeof res.locals.canModule === 'function') {
        // Module-level (view) gate — a role with no access to the module at all.
        if (!res.locals.canModule(mod)) return forbid();
        // Per-ACTION gate: a hand-typed /products/add or /products/5/edit (or a
        // delete POST) must be blocked when the role lacks create/edit/delete —
        // not just hidden. The api ALSO enforces can() on the data mutation, so
        // this is defence-in-depth + a friendly Forbidden instead of a raw 403.
        if (typeof res.locals.canDo === 'function') {
            const tail = parts.slice(1).map((s) => s.toLowerCase());
            if ((tail.includes('add') || tail.includes('create') || tail.includes('new'))
                && !res.locals.canDo(mod, 'create')) return forbid();
            // 'edit' + write-ish sub-paths (e.g. /inventory/adjust) need edit.
            if ((tail.includes('edit') || tail.includes('adjust'))
                && !res.locals.canDo(mod, 'edit')) return forbid();
            if (tail.includes('delete') && !res.locals.canDo(mod, 'delete')) return forbid();
        }
    }
    return next();
});

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

/* The agent is "connected" only if its last heartbeat landed within this window.
 * MUST match the api's CONNECTED_WINDOW_MS (SyncController + LicenseController =
 * 150s = 2.5 missed 60s beats) so the Sync Dashboard's connection state is
 * IDENTICAL to the License detail "Agent Online/Offline" for the same agent. The
 * api already computes `connected` from licenses.last_seen_at; the web re-applies
 * this freshness rule defensively against the returned heartbeat timestamp so a
 * STALE/ABSENT heartbeat can NEVER render a fake "Connected" — it reads
 * Disconnected/Offline, honestly, like the License page. */
const SYNC_CONNECTED_WINDOW_MS = 150 * 1000;

/* True iff `tsIso` (an ISO heartbeat/last_seen string) is within the connected
 * window of now. Missing/blank/unparseable → false (no fresh heartbeat). */
function isHeartbeatFresh(tsIso) {
    if (!tsIso) return false;
    const t = new Date(tsIso).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) <= SYNC_CONNECTED_WINDOW_MS;
}

/* Generic list fetch: forwards page/per_page/search/status query params to
 * the api and returns { rows, meta }. Each page maps `rows` to its view's
 * expected field names before rendering. */
async function apiList(req, basePath) {
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = parseInt(req.query.per_page, 10) || 10;

    // basePath MAY already carry a query string (e.g. the Approvals screen passes
    // '/sales-invoices?approval=pending'). PARSE it out and MERGE, using qs.set()
    // throughout so we NEVER emit a duplicate key. A duplicated 'page' (basePath
    // had page=1 AND we add page=1) reaches the api as an ARRAY → Joi rejects it
    // with 422 ("page must be a number") → the whole list comes back empty. That
    // was exactly why the admin's approval queue rendered "All caught up".
    const qIdx = basePath.indexOf('?');
    const path = qIdx === -1 ? basePath : basePath.slice(0, qIdx);
    const qs   = new URLSearchParams(qIdx === -1 ? '' : basePath.slice(qIdx + 1));

    qs.set('page', String(page));
    qs.set('per_page', String(perPage));
    if (req.query.search)   qs.set('search', String(req.query.search));
    if (req.query.status)   qs.set('status', String(req.query.status));
    if (req.query.approval) qs.set('approval', String(req.query.approval));
    if (req.query.sort)     qs.set('sort',  String(req.query.sort));
    if (req.query.order)    qs.set('order', String(req.query.order));
    // Forward filter dropdown params so the api can actually filter the list.
    for (const k of ['location', 'sales_person', 'customer_group', 'supplier_group', 'gst',
        'category', 'gst_rate', 'hsn', 'parent', 'state', 'financial_year', 'created_from', 'created_to',
        'date_from', 'date_to',
        // Dashboard tile drill-downs (kpi-panel → filtered list).
        'group', 'inactive', 'missing', 'overdue']) {
        if (req.query[k]) qs.set(k, String(req.query[k]));
    }

    const { body } = await api.get(req, `${path}?${qs.toString()}`);
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

/* Tally party-eligible ledger groups (Sundry Debtors / Sundry Creditors
 * ancestry) as plain group-name strings for the customer form's "Ledger
 * Group" field. `customers.ledger_group` stores the NAME (free text on the
 * table), not a Tally group id, so only the names are kept — unlike
 * fetchOptions() which returns {id,name} pairs for real FK <select>s.
 * Empty when no Tally groups are synced yet (two of three demo tenants) —
 * the form falls back to a plain text input in that case. */
async function fetchLedgerGroupOptions(req) {
    const { body } = await api.get(req, '/tally/ledger-groups');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => r.name).filter(Boolean);
}

/* Customer options for the invoice form — id + name PLUS the customer's own
 * location (id + label) so the Customer <select> can AUTO-fill the Location
 * field on selection. /customers is assignment-scoped, so a salesman gets only
 * their assigned customers here (canCustomerRead). */
async function fetchCustomerInvoiceOptions(req) {
    const { body } = await api.get(req, '/customers?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        location_id: r.location_id != null ? r.location_id : '',
        location: r.location || '',
    }));
}

/* Sales ledgers (Tally group "Sales Accounts") for the Quotation form's
 * "Ledger Type" combobox — see GET /tally/ledgers/sales-options. */
async function fetchSalesLedgerOptions(req) {
    const { body } = await api.get(req, '/tally/ledgers/sales-options');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => ({ id: r.id, name: r.name, parent: r.parent || '' }));
}

/* Assignable roles as {id,name,slug} for the Sales-Person login-role select —
 * keeps `slug` (unlike fetchOptions) so the view can default-highlight the
 * system "sales-person" role. */
async function fetchRoleOptions(req) {
    const { body } = await api.get(req, '/roles?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug }));
}

/* Locations as the richer card objects the Sales-Person "Assigned Locations"
 * grid renders (id + name + code + city + state). Real ids are submitted as
 * location_ids[] → PUT /sales-persons/:id/locations. */
async function fetchLocationCards(req) {
    const { body } = await api.get(req, '/locations?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    return rows.map((r) => ({
        id: r.id, name: r.name, code: r.code || '', city: r.city || '', state: r.state || '',
        customers: r.customers || '',
    }));
}

/* All company customers bucketed by location_id → { '<locId>': [{id,name,mobile}] }.
 * The /customers list carries customers.* (so location_id is present); the
 * crudController list has no per-location query filter, so we fetch once and
 * group client-side. Used to build the per-location checklists in the
 * Sales-Person "Customer Assign" tab. */
async function fetchCustomersByLocation(req) {
    const { body } = await api.get(req, '/customers?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    const byLoc = {};
    for (const r of rows) {
        if (r.location_id == null) continue;
        const key = String(r.location_id);
        if (!byLoc[key]) byLoc[key] = [];
        byLoc[key].push({ id: r.id, name: r.name, mobile: r.mobile || '' });
    }
    return byLoc;
}

/* Forward the Sales-Person form's OPTIONAL login to POST /sales-persons/:id/login
 * (create-or-update the linked login user). Login is OPT-IN and keyed off the
 * PASSWORD: only when a password is supplied do we create/update a login. The
 * sales person's SINGLE email (b.email) doubles as the login email — there is
 * no separate login_email field anymore. Returns a per-action flash result
 * { ok, msg } or null when no password was given (no login wanted → skip). The
 * api enforces dup-email + seat-limit + role-assignability — we surface its msg. */
async function applySalesPersonLogin(req, id, b) {
    const pass = (b.password || '').trim();
    // No password ⇒ the operator does not want a login. Skip entirely so the
    // base sales person still saves cleanly (the main bug we are fixing).
    if (!pass) return null;
    const email  = (b.email || '').trim();
    const roleId = _num(b.role_id);
    const payload = { email, role_id: roleId, password: pass };
    const result = await api.post(req, `/sales-persons/${id}/login`, payload);
    return { ok: apiOk(result), msg: apiError(result, 'Could not save the login.'), raw: result };
}

/* Normalise a checkbox group value into a positive-int array. The extended
 * (qs) body parser returns: an array for a normal multi-value group, a scalar
 * for a single value, OR — when a group has MORE than qs's default arrayLimit
 * (20) entries — a plain OBJECT keyed by numeric index ({0:..,1:..,…}). The
 * per-location customer checklist can easily exceed 20 (the hidden empty input
 * + 20 ticks), so we MUST handle the object form or every id is lost. */
function toPosIntArray(v) {
    if (v == null) return [];
    let arr;
    if (Array.isArray(v)) arr = v;
    else if (typeof v === 'object') arr = Object.values(v); // qs arrayLimit overflow
    else arr = [v];
    return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}

/* Forward the selected Assigned-Locations to PUT /sales-persons/:id/locations.
 * location_ids[] arrives as a string|string[]|object; normalise to a number[]. */
async function applySalesPersonLocations(req, id, b) {
    const location_ids = toPosIntArray(b['location_ids']);
    const result = await api.put(req, `/sales-persons/${id}/locations`, { location_ids });
    return { ok: apiOk(result), msg: apiError(result, 'Could not save the assigned locations.') };
}

/* Forward per-location customer ticks to PUT /sales-persons/:id/customers, once
 * per location key. customer_ids arrives as { 'loc<id>': string|string[] } from
 * the name="customer_ids[loc<id>][]" inputs — the "loc" prefix keeps it an
 * OBJECT key in the extended body parser (a bare number would become a sparse
 * array index and lose the location id). A location with no ticks still submits
 * an empty-value hidden input, so the key is always present and unticking
 * everything clears that location. */
async function applySalesPersonCustomers(req, id, b) {
    const map = (b && b.customer_ids && typeof b.customer_ids === 'object') ? b.customer_ids : null;
    if (!map) return { ok: true, msg: '' };
    let allOk = true;
    let firstErr = '';
    for (const locKey of Object.keys(map)) {
        const locationId = Number(String(locKey).replace(/^loc/, ''));
        if (!Number.isInteger(locationId) || locationId <= 0) continue;
        const customer_ids = toPosIntArray(map[locKey]);
        const result = await api.put(req, `/sales-persons/${id}/customers`, { location_id: locationId, customer_ids });
        if (!apiOk(result)) { allOk = false; if (!firstErr) firstErr = apiError(result, 'Could not save customer assignments.'); }
    }
    return { ok: allOk, msg: firstErr };
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
        // Current stock on hand (Tally closing balance) — the create screen caps
        // the line Qty at this; the api enforces the same rule server-side.
        stock: p.opening_stock != null ? parseFloat(p.opening_stock) : 0,
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
 * license's custom roles) may reach the unified /roles screen. The api enforces
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
        // Role-based landing:
        //  • Super Admin is a platform operator (no tenant data) → their overview
        //    is the Licenses screen (total licences, companies, expiry, sync…).
        //  • ANY non-admin role that wasn't granted the Dashboard module has no
        //    KPI page to land on (it would 403) → their own "My Dashboard"
        //    (/my-field). Covers a field salesman AND any custom role (e.g. one
        //    given only Products/Invoices) whose role has no dashboard.view.
        //    Company-admin always keeps the KPI dashboard.
        if (res.locals.isSuperAdmin) return res.redirect('/licenses');
        // A field salesman lands on their own "My Field" dashboard (visits/approvals).
        if (res.locals.isSalesman) return res.redirect('/my-field');
        // A customer-portal login gets a simple stats dashboard: their assigned
        // categories/products (API-scoped lists) + their own invoices. The list
        // meta.total carries the counts — no dashboard.view permission needed.
        if (res.locals.isCustomerUser) {
            const cuGrp = (v) => Number(v || 0).toLocaleString('en-IN');
            const cuInr = (v) => '₹' + cuGrp(v);
            const cuMeta = (r) => {
                const m = (r && r.body && r.body.data && r.body.data.meta) || {};
                return {
                    total: Number.isFinite(Number(m.total)) ? Number(m.total) : 0,
                    amount: Number(m.grand_total) || 0,
                };
            };
            const [catR, prodR, allR, pendR, apprR] = await Promise.all([
                api.get(req, '/categories?per_page=1').catch(() => null),
                api.get(req, '/products?per_page=1').catch(() => null),
                api.get(req, '/sales-invoices?per_page=1&approval=all').catch(() => null),
                api.get(req, '/sales-invoices?per_page=1&approval=pending').catch(() => null),
                api.get(req, '/sales-invoices?per_page=1&approval=approved').catch(() => null),
            ]);
            const inv = cuMeta(allR), pend = cuMeta(pendR), appr = cuMeta(apprR);
            return res.render('dashboard/index', {
                title: 'Dashboard',
                activeMenu: 'dashboard',
                breadcrumb: [{ label: 'Dashboard' }],
                welcomeOnly: false,
                statsOnly: true,
                welcomeName: (res.locals.user && res.locals.user.name) || 'there',
                stats: [
                    { label: 'My Categories',     value: cuGrp(cuMeta(catR).total),  icon: 'fa-tags',              tone: 'purple', href: '/categories' },
                    { label: 'My Products',       value: cuGrp(cuMeta(prodR).total), icon: 'fa-box',               tone: 'teal',   href: '/products' },
                    { label: 'My Invoices',       value: cuGrp(inv.total),           icon: 'fa-file-invoice',      tone: 'blue',   href: '/sales-invoices' },
                    { label: 'Invoice Amount',    value: cuInr(inv.amount),          icon: 'fa-indian-rupee-sign', tone: 'indigo', href: '/sales-invoices' },
                    { label: 'Pending Invoices',  value: cuGrp(pend.total),          icon: 'fa-hourglass-half',    tone: 'amber',  href: '/sales-invoices?approval=pending' },
                    { label: 'Approved Invoices', value: cuGrp(appr.total),          icon: 'fa-circle-check',      tone: 'green',  href: '/sales-invoices?approval=approved' },
                ],
                salesChart: { labels: [], data: [] }, syncChart: { labels: [], data: [] },
                recentInvoices: [], recentSync: [],
            });
        }
        // A NON-salesman whose role was NOT granted the Dashboard module has no KPI
        // page to show (the summary API would 403). Instead of bouncing them to the
        // salesman screen, render the dashboard shell with a friendly WELCOME message
        // and no figures — so they land somewhere sensible after login.
        const _canDash = res.locals.isCompanyAdmin
            || (typeof res.locals.canModule !== 'function')
            || res.locals.canModule('dashboard');
        if (!_canDash) {
            return res.render('dashboard/index', {
                title: 'Dashboard',
                activeMenu: 'dashboard',
                breadcrumb: [{ label: 'Dashboard' }],
                welcomeOnly: true,
                welcomeName: (res.locals.user && res.locals.user.name) || 'there',
                // Empty datasets so the view's guards render nothing / never crash.
                stats: [], salesChart: { labels: [], data: [] }, syncChart: { labels: [], data: [] },
                recentInvoices: [], recentSync: [],
            });
        }
        return res.render('dashboard/index', {
            title: 'Dashboard',
            activeMenu: 'dashboard',
            breadcrumb: [{ label: 'Dashboard' }],
            ...(await buildDashboardModel(req, res)),

            // Chart.js init for THIS page only. Passed as a real render local
            // (NOT assigned inside the template) so it reaches the layout's
            // `pageScript` slot, which sits AFTER the Chart.js CDN tag in
            // _layout.ejs — guaranteeing Chart is defined before this runs.
            pageScript: '<script src="/js/dashboard.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── Dashboard panel fragments (GET /dashboard/section) ──────────
 * Every dashboard control (the range <select>, the Day Book day pills)
 * re-renders ONLY its own panel over fetch — the browser URL never
 * changes and the other panels are never re-queried on the client.
 * `section` picks which fragment to return; the fragments are the same
 * partials the full page composes itself from, so there is exactly one
 * copy of each panel's markup.
 *
 * Responds 400 for an unknown section rather than silently returning the
 * whole page, so a typo surfaces instead of bloating every swap. */
const DASHBOARD_SECTIONS = {
    summary:      'dashboard/_summary',
    salesreceipt: 'dashboard/_sales-receipt',
    receivables:  'dashboard/_receivables',
    top10:        'dashboard/_top10',
    daybook:      'dashboard/_daybook',
};

router.get('/dashboard/section', async (req, res, next) => {
    try {
        const view = DASHBOARD_SECTIONS[String(req.query.section || '').toLowerCase()];
        if (!view) return res.status(400).send('Unknown dashboard section.');

        // Same role gating GET / applies before it renders the KPI dashboard.
        // Without this a super-admin (who has no tenant database bound) would
        // reach /dashboard/summary and the API would 500 on the first
        // tenant-table query. These roles never see these panels anyway.
        const barred = res.locals.isSuperAdmin || res.locals.isSalesman || res.locals.isCustomerUser
            || !(res.locals.isCompanyAdmin
                 || typeof res.locals.canModule !== 'function'
                 || res.locals.canModule('dashboard'));
        if (barred) return res.status(204).end();

        // Ask the API for THIS panel's aggregates only — a fragment that
        // recomputed all of them (ageing, leaderboards, anti-joins) took
        // seconds for numbers it then threw away.
        const section = String(req.query.section || '').toLowerCase();
        const model = await buildDashboardModel(req, res, section);
        return res.render(view, { ...model, layout: false });
    } catch (err) { next(err); }
});

/**
 * Build every dashboard panel's view model from ONE /dashboard/summary call.
 * Shared by the full page render and the fragment endpoint so both always
 * agree on formatting, permissions and drill-down links.
 */
async function buildDashboardModel(req, res, section) {
        // Summary panel date range (?range=this_year etc). resolveRange falls
        // back to this_year for a missing or hand-edited value, so `range` is
        // always a real preset with from/to dates. The ledger-derived balances
        // are point-in-time and ignore it; the money metrics below honour it.
        const now    = new Date();
        const ranges = buildRanges(now);
        const range  = resolveRange(String(req.query.range || DEFAULT_RANGE), now);
        // ?daybook=YYYY-MM-DD picks the Day Book panel's day; anything else is
        // dropped here so a hand-edited value never reaches the API.
        const dayParam = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.daybook || ''))
            ? `&daybook=${req.query.daybook}` : '';
        // ?parts= narrows the API's work to the panel being rendered. The full
        // page passes no section, so it still gets every aggregate in one call.
        const PART_OF_SECTION = {
            summary: 'summary', salesreceipt: 'salesreceipt',
            receivables: 'receivables', top10: 'top10', daybook: 'daybook',
        };
        const part = PART_OF_SECTION[String(section || '')];
        const partParam = part ? `&parts=${part}` : '';
        const { body } = await api.get(req,
            `/dashboard/summary?from=${range.from}&to=${range.to}${dayParam}${partParam}`);
        const data = (body && body.data) || {};

        const counts = data.counts || {};
        const balances  = data.balances  || {};
        const attention = data.attention || {};
        const sc = data.sales_chart || {};
        const syc = data.sync_chart || {};
        const recInv = Array.isArray(data.recent_invoices) ? data.recent_invoices : [];
        const recSync = Array.isArray(data.recent_sync) ? data.recent_sync : [];

        // Number helpers: Indian-grouped integers for display strings, so
        // the API numbers render exactly like the pre-formatted mock values.
        const num = (v) => Number(v || 0);
        const grp = (v) => num(v).toLocaleString('en-IN');
        const inr = (v) => '₹' + grp(v);

        // Tiles are gated per module exactly as the old stat cards were: a tile
        // whose target module the user cannot view is dropped, and a panel left
        // with no tile is omitted entirely rather than rendering an empty box.
        const _canMod = (m) => (typeof res.locals.canModule === 'function') ? res.locals.canModule(m) : true;

        // ── Summary panel ─────────────────────────────────────────────
        // The date-range <select> navigates to /?range=<value>, so the panel
        // needs no client-side fetch. Rendered as raw HTML into the partial's
        // `control` slot.
        const rangeOptions = ranges.map((r) =>
            `<option value="${r.value}"${r.value === range.value ? ' selected' : ''}>`
            + `${r.label}</option>`).join('');
        // No onchange handler and no form: dashboard.js listens for changes on
        // [data-dash-range] and re-fetches ONLY the panel the select sits in
        // (each panel keeps its own period), leaving the browser URL untouched.
        // `no-search` opts out of app.js's searchable-select enhancement: it
        // kicks in above 8 options, and its filter box truncated these nine
        // long labels. A plain native select shows each period in full.
        const rangeControl =
            '<select class="kpi-panel-select no-search" aria-label="Date range" data-dash-range>'
            + rangeOptions + '</select>';

        // Ledger balances are signed (debit-positive). Print the magnitude with
        // its Dr/Cr marker, the way Tally and the Cash & Bank screens do — a
        // bare "₹-49,82,654" reads like a bug rather than an overdraft.
        const inrDc = (v) => {
            const n = Number(v || 0);
            if (n === 0) return inr(0);
            return `${inr(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`;
        };
        const summaryTiles = [
            { label: 'Cash',             value: inrDc(balances.cash),    href: '/cash' },
            { label: 'Bank',             value: inrDc(balances.bank),    href: '/bank' },
            { label: 'Inventory Amount', value: inr(counts.stock_value), href: '/products', perm: 'inventory' },
            { label: 'Payables',         value: inrDc(balances.payables), href: '/payables', perm: 'suppliers' },
        ].filter((t) => (t.perm ? _canMod(t.perm) : true));

        // ── Need Attention panel ──────────────────────────────────────
        const missingMobile = num(attention.missing_mobile);
        const missingEmail  = num(attention.missing_email);
        const attentionTiles = [
            {
                label: 'Inactive Customers',
                value: grp(attention.inactive_customers),
                href:  '/customers?inactive=90',
                perm:  'customers',
            },
            {
                label: 'Inactive Stocks',
                value: grp(attention.inactive_stocks),
                href:  '/products?inactive=90',
                perm:  'products',
            },
            {
                label:  'Payment Reminders',
                locked: true,
                sub:    `<strong>${grp(missingMobile)}</strong> Mobile Missing &nbsp; `
                      + `<strong>${grp(missingEmail)}</strong> Email Missing`,
                href:   '/customers?missing=contact',
                perm:   'customers',
            },
            {
                label: 'Overdue Invoices',
                value: grp(attention.overdue_count),
                sub:   inr(attention.overdue_amount),
                href:  '/sales-invoices?overdue=1',
                perm:  'sales-invoices',
            },
        ].filter((t) => (t.perm ? _canMod(t.perm) : true));

        const summaryPanel = summaryTiles.length
            ? { title: 'Summary', tone: 'default', control: rangeControl, tiles: summaryTiles }
            : null;
        const attentionPanel = attentionTiles.length
            ? { title: 'Need Attention', tone: 'danger', control: '', tiles: attentionTiles }
            : null;

        // ── Row 2: Sales & Receipt + Receivables ──────────────────────
        // Formatted here so the view stays presentational. A null change_pct
        // (no previous month to compare against) yields no delta caption at
        // all, rather than an invented "100% down".
        const sr = data.sales_receipt || {};
        const delta = (v) => {
            if (v == null || !Number.isFinite(Number(v))) return null;
            const n = Number(v);
            return { down: n < 0, text: `${Math.abs(n).toFixed(0)} %` };
        };
        const salesReceipt = {
            total_sales:        inr(sr.total_sales),
            total_receipt:      inr(sr.total_receipt),
            sales_this_month:   inr(sr.sales_this_month),
            receipt_this_month: inr(sr.receipt_this_month),
            sales_delta:        delta(sr.sales_change_pct),
            receipt_delta:      delta(sr.receipt_change_pct),
        };

        // Ageing band colours, oldest-last — the doughnut and the legend read
        // the same list so a swatch always matches its arc.
        const RECV_COLORS = ['#6EE7B7', '#F87171', '#FB923C', '#FCD34D', '#A5B4FC', '#60A5FA'];
        const rv = data.receivables || {};
        const rvBuckets = Array.isArray(rv.buckets) ? rv.buckets : [];
        const receivables = {
            total:         inr(rv.total),
            overdue:       inr(rv.overdue),
            projection_15: inr(rv.projection_15),
            projection_60: inr(rv.projection_60),
            buckets: rvBuckets.map((b, i) => ({
                label:  b.label,
                amount: inr(b.amount),
                color:  RECV_COLORS[i] || '#9CA3AF',
            })),
        };

        // Chart payload for /js/dashboard.js — raw numbers, not display strings.
        const salesReceiptChart = {
            labels:  Array.isArray(sr.labels)  ? sr.labels  : [],
            sales:   Array.isArray(sr.sales)   ? sr.sales   : [],
            receipt: Array.isArray(sr.receipt) ? sr.receipt : [],
        };
        const receivablesChart = {
            labels: rvBuckets.map((b) => b.label),
            data:   rvBuckets.map((b) => Number(b.amount || 0)),
            colors: rvBuckets.map((_, i) => RECV_COLORS[i] || '#9CA3AF'),
        };

        // ── Row 3: Top 10 + Day Book ──────────────────────────────────
        const t10 = data.top10 || {};
        // Party rows carry the Dr/Cr marker inline (₹43,19,793 Dr), item rows
        // carry a separate quantity column on the two "by quantity" tabs.
        // Every row drills into its master list, searched by name — the same
        // convention the Day Book voucher links use.
        const nameHref = (base, name) => (name ? `${base}?search=${encodeURIComponent(name)}` : null);
        const partyRows = (list, base) => (Array.isArray(list) ? list : [])
            .map((r) => ({ name: r.name, value: `${inr(r.value)} ${r.dc}`, href: nameHref(base, r.name) }));
        const itemRows = (list, withQty) => (Array.isArray(list) ? list : [])
            .map((r) => ({
                name: r.name, value: inr(r.value),
                qty: withQty ? grp(r.qty) : null,
                href: nameHref('/products', r.name),
            }));

        const top10Tabs = [
            { key: 'customers',  label: 'Customers',                rows: partyRows(t10.customers, '/customers') },
            { key: 'suppliers',  label: 'Suppliers',                rows: partyRows(t10.suppliers, '/suppliers') },
            { key: 'sold_qty',   label: 'Items Sold By Quantity',   rows: itemRows(t10.items_sold_qty, true) },
            { key: 'sold_val',   label: 'Items Sold By Value',      rows: itemRows(t10.items_sold_value, false) },
            { key: 'bought_qty', label: 'Items Purchased By Quantity', rows: itemRows(t10.items_purchased_qty, true) },
            { key: 'bought_val', label: 'Items Purchased By Value',    rows: itemRows(t10.items_purchased_value, false) },
        ];

        // Day Book. The Today / Yesterday / date-picker control posts back as
        // ?daybook=YYYY-MM-DD; the API echoes the date it actually used, so the
        // active pill is derived from the response rather than the request.
        const isoDay = (d) => {
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        };
        const _today     = isoDay(now);
        const _yesterday = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
        const bookDate   = data.day_book_date || _today;

        // Each voucher links to its module's list, pre-filtered by voucher
        // number — the only drill-down every voucher kind actually has.
        const VOUCHER_PATH = {
            'sales-invoice':    '/sales-invoices',
            'purchase-invoice': '/purchase-invoices',
            payment:            '/payments',
            journal:            '/journals',
        };
        // dd/mm/yyyy for the Custom Date pill — the calendar popup shows the
        // same format in its footer, so the two never disagree.
        const dayLabel = (iso) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
            return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
        };
        const dayBook = {
            date:       bookDate,
            date_label: dayLabel(bookDate),
            today:     _today,
            yesterday: _yesterday,
            active:    bookDate === _today ? 'today' : (bookDate === _yesterday ? 'yesterday' : 'custom'),
            rows: (Array.isArray(data.day_book) ? data.day_book : []).map((r) => ({
                voucher:     r.voucher_no,
                particulars: r.particulars,
                type:        r.type,
                amount:      inr(r.amount),
                href: r.voucher_no
                    ? `${VOUCHER_PATH[r.kind] || '/sales-invoices'}?search=${encodeURIComponent(r.voucher_no)}`
                    : null,
            })),
        };

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
            amount:   inr(r.total),
            status:   txStatusLabel(r.status),
            date:     fmtDate(r.invoice_date),
            // Same drill-down convention the Day Book rows use: the module's
            // list, pre-filtered by voucher number.
            href: r.invoice_no
                ? `/sales-invoices?search=${encodeURIComponent(r.invoice_no)}`
                : null,
        }));

        // recent_sync → the compact activity list. Title-case the status so
        // both the visible pill text and _syncPillClass (Synced/Pending/
        // Failed) resolve correctly. Prefer record_type+record_id for the
        // record line, falling back to either alone.
        const titleCase = (v) => {
            const s = String(v || '');
            return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
        };
        // Sync-log module slug → the list page that record lives on, so each
        // activity row is a drill-down rather than dead text.
        const SYNC_MODULE_PATH = {
            customers: '/customers',
            suppliers: '/suppliers',
            products:  '/products',
            categories: '/categories',
            invoices:  '/sales-invoices',
            sales_invoices: '/sales-invoices',
            purchase_invoices: '/purchase-invoices',
            payments:  '/payments',
            journals:  '/journals',
            ledgers:   '/ledgers',
        };
        const recentSync = recSync.map((r) => {
            const mod = String(r.module || '').toLowerCase();
            return {
                module: r.module || '',
                record: [r.record_type, r.record_id].filter(Boolean).join(' ') || r.record_id || r.record_type || '',
                status: titleCase(r.status),
                time:   fmtDate(r.created_at),
                href:   SYNC_MODULE_PATH[mod] || null,
            };
        });

        return {
            // Page data (API-driven).
            summaryPanel,
            attentionPanel,
            salesReceipt,
            receivables,
            salesReceiptChart,
            receivablesChart,
            top10Tabs,
            dayBook,
            // stats stays for the customer-portal (statsOnly) branch, which
            // still renders the classic stat cards. Empty on the main dashboard.
            stats: [],
            salesChart,
            syncChart,
            recentInvoices,
            recentSync,
        };
}

/* ── MASTERS · Companies listing (GET /companies) — REAL API ──── */
router.get('/companies', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/companies');
        const config = await fetchConfig(req, ['financial_years']);
        const companyRows = rows.map((r) => {
            let cf = {};
            try { cf = (typeof r.custom_fields === 'string') ? JSON.parse(r.custom_fields || '{}') : (r.custom_fields || {}); } catch (_) { cf = {}; }
            const cfRows = Object.keys(cf).map((k) => ({ label: k, value: String(cf[k] || '—') }));
            return {
                id: r.id, name: r.name, gst: r.gst_number || '', pan: r.pan_number || '',
                mobile: r.mobile || '', email: r.email || '', financial_year: r.financial_year || '',
                status: r.status, created_at: fmtDate(r.created_at),
                // Full tab-wise detail for the View popup (every field, grouped by tab).
                _detail: [
                    { group: 'Basic Information' },
                    { label: 'Company Name', value: r.name || '—' },
                    { label: 'Mailing Name', value: r.mailing_name || '—' },
                    { label: 'Email', value: r.email || '—' },
                    { label: 'Mobile', value: r.mobile || '—' },
                    { label: 'Phone', value: r.phone || '—' },
                    { label: 'Status', value: r.status || '—' },
                    { group: 'Address' },
                    { label: 'Street Address', value: r.address || '—' },
                    { label: 'State', value: r.state || '—' },
                    { label: 'Pincode', value: r.pincode || '—' },
                    { label: 'Country', value: r.country || '—' },
                    { group: 'Tax & Statutory' },
                    { label: 'GST Number', value: r.gst_number || '—' },
                    { label: 'PAN Number', value: r.pan_number || '—' },
                    { group: 'Financial Year' },
                    { label: 'Financial Year', value: r.financial_year || '—' },
                    { label: 'Books Beginning From', value: r.books_from || '—' },
                ].concat(cfRows.length ? [{ group: 'Custom Fields' }].concat(cfRows) : []),
            };
        });
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

/* Assemble Custom Fields (key/value form rows: cf_key[] + cf_val[]) -> object. */
function assembleCustomFields(b) {
    const keys = [].concat(b.cf_key || []);
    const vals = [].concat(b.cf_val || []);
    const out = {};
    keys.forEach((k, i) => {
        const kk = String(k || '').trim();
        if (kk) out[kk] = String(vals[i] || '');
    });
    return out;
}

/* ── CSV export helpers ──────────────────────────────────────────
 * Build a CSV (all columns, not just the visible table) for the page-head
 * Export links. Logo is exported as a FULL URL path, custom fields flattened. */
function csvEscape(v) {
    v = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
    if (/[",]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
}
function rowsToCsv(headers, records, mapFn) {
    const lines = [headers.map(csvEscape).join(',')];
    records.forEach((r) => { lines.push(mapFn(r).map(csvEscape).join(',')); });
    return lines.join('\r\n');
}
function cfFlat(raw) {
    let cf = {};
    try { cf = (typeof raw === 'string') ? JSON.parse(raw || '{}') : (raw || {}); } catch (_) { cf = {}; }
    return Object.keys(cf).map((k) => `${k}=${cf[k]}`).join('; ');
}
function fullLogoUrl(req, logo) {
    if (!logo) return '';
    if (/^https?:/i.test(logo)) return logo;
    return `${req.protocol}://${req.get('host')}${logo.charAt(0) === '/' ? '' : '/'}${logo}`;
}
function sendCsv(res, filename, csv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('﻿' + csv);   // BOM so Excel reads UTF-8 / ₹ correctly
}

/* ── MASTERS · Export Companies (GET /companies/export) ─── all columns ── */
router.get('/companies/export', async (req, res, next) => {
    try {
        const result = await api.get(req, '/companies?per_page=100&page=1');
        const records = (result.body && result.body.data && result.body.data.data) || [];
        const headers = ['Name', 'Mailing Name', 'Email', 'Mobile', 'Phone', 'GST Number',
            'PAN Number', 'Street Address', 'State', 'Pincode', 'Country', 'Financial Year',
            'Books From', 'Status', 'Logo URL', 'Custom Fields', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.mailing_name, r.email, r.mobile, r.phone, r.gst_number,
            r.pan_number, r.address, r.state, r.pincode, r.country, r.financial_year,
            r.books_from, r.status, fullLogoUrl(req, r.logo), cfFlat(r.custom_fields), r.created_at,
        ]);
        return sendCsv(res, 'companies.csv', csv);
    } catch (err) { next(err); }
});

/* ── MASTERS · Export Locations (GET /locations/export) ── all columns ── */
router.get('/locations/export', async (req, res, next) => {
    try {
        const result = await api.get(req, '/locations?per_page=100&page=1');
        const records = (result.body && result.body.data && result.body.data.data) || [];
        const headers = ['Name', 'Code', 'City', 'State', 'Pincode', 'Mobile', 'Manager',
            'Is Tally Godown', 'Status', 'Custom Fields', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.code, r.city, r.state, r.pincode, r.mobile, r.manager,
            (r.is_tally_godown ? 'Yes' : 'No'), r.status, cfFlat(r.custom_fields), r.created_at,
        ]);
        return sendCsv(res, 'locations.csv', csv);
    } catch (err) { next(err); }
});

/* Fetch ALL rows of a list endpoint by paging (per_page is capped at 100). */
async function fetchAllRows(req, basePath) {
    let all = [];
    for (let page = 1; page <= 100; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await api.get(req, `${basePath}?per_page=100&page=${page}`);
        const payload = (result.body && result.body.data) || {};
        const batch   = Array.isArray(payload.data) ? payload.data : [];
        all = all.concat(batch);
        const total = (payload.meta && payload.meta.total) || all.length;
        if (batch.length === 0 || all.length >= total) break;
    }
    return all;
}

/* ── MASTERS · Export Customers (GET /customers/export) ── all columns ── */
router.get('/customers/export', async (req, res, next) => {
    try {
        const records = await fetchAllRows(req, '/customers');
        const headers = ['Name', 'Location', 'Mobile', 'Alternate Mobile', 'Email', 'GST Number',
            'PAN Number', 'Billing Address', 'Shipping Address', 'Opening Balance', 'Credit Limit',
            'Sales Person', 'Customer Group', 'Status', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.location, r.mobile, r.alternate_mobile, r.email, r.gst_number,
            r.pan_number, r.billing_address, r.shipping_address, r.opening_balance, r.credit_limit,
            r.sales_person, r.customer_group, r.status, r.created_at,
        ]);
        return sendCsv(res, 'customers.csv', csv);
    } catch (err) { next(err); }
});

/* ── MASTERS · Export Suppliers (GET /suppliers/export) ── all columns ── */
router.get('/suppliers/export', async (req, res, next) => {
    try {
        const records = await fetchAllRows(req, '/suppliers');
        const headers = ['Name', 'Location', 'Mobile', 'Alternate Mobile', 'Email', 'GST Number',
            'PAN Number', 'Supplier Group', 'Address', 'Opening Balance', 'Payment Terms',
            'Status', 'Custom Fields', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.location, r.mobile, r.alternate_mobile, r.email, r.gst_number,
            r.pan_number, r.supplier_group, r.address, r.opening_balance, r.payment_terms,
            r.status, cfFlat(r.custom_fields), r.created_at,
        ]);
        return sendCsv(res, 'suppliers.csv', csv);
    } catch (err) { next(err); }
});

/* ── MASTERS · Export Products (GET /products/export) ── all columns ── */
router.get('/products/export', async (req, res, next) => {
    try {
        const records = await fetchAllRows(req, '/products');
        const headers = ['Name', 'SKU', 'Category', 'Unit', 'HSN Code', 'GST Rate',
            'Purchase Price', 'Sales Price', 'Opening Stock', 'Status', 'Description',
            'Custom Fields', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.sku, r.category, r.unit, r.hsn_code, r.gst_rate,
            r.purchase_price, r.sales_price, r.opening_stock, r.status, r.description,
            cfFlat(r.custom_fields), r.created_at,
        ]);
        return sendCsv(res, 'products.csv', csv);
    } catch (err) { next(err); }
});

/* ── MASTERS · Export Categories (GET /categories/export) ── all columns ── */
router.get('/categories/export', async (req, res, next) => {
    try {
        const records = await fetchAllRows(req, '/categories');
        const headers = ['Name', 'Parent Category', 'Status', 'Created At'];
        const csv = rowsToCsv(headers, records, (r) => [
            r.name, r.parent, r.status, r.created_at,
        ]);
        return sendCsv(res, 'categories.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Export Sales Register (month-wise, as shown) ── */
router.get('/sales-invoices/register/export', async (req, res, next) => {
    try {
        const { rows: months, meta } = await apiList(req, '/sales-invoices/monthly');
        const grand = (meta && meta.grand_total) || 0;
        const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const mlabel = (ym) => { const p = String(ym).split('-'); return (MN[Number(p[1])] || ym) + ' ' + p[0]; };
        const headers = ['Month', 'No. of Vouchers', 'Sales Amount', 'Closing Balance'];
        let totalVch = 0;
        const records = (months || []).map((m) => {
            totalVch += Number(m.count) || 0;
            return [mlabel(m.month), m.count, Number(m.total).toFixed(2), Number(m.closing).toFixed(2)];
        });
        records.push(['Grand Total', totalVch, Number(grand).toFixed(2), Number(grand).toFixed(2)]);
        const csv = rowsToCsv(headers, records, (r) => r);
        return sendCsv(res, 'sales-register.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Export a month's Sales vouchers (drill-down, as shown) ── */
router.get('/sales-invoices/export', async (req, res, next) => {
    try {
        const month = String(req.query.month || '').trim();
        let dateQs = '';
        if (/^\d{4}-\d{2}$/.test(month)) {
            const [yy, mm] = month.split('-').map(Number);
            const lastDay = new Date(yy, mm, 0).getDate();
            dateQs = `&date_from=${month}-01&date_to=${month}-${String(lastDay).padStart(2, '0')}`;
        }
        let all = [];
        for (let page = 1; page <= 200; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await api.get(req, `/sales-invoices?per_page=100&page=${page}${dateQs}`);
            const payload = (result.body && result.body.data) || {};
            const batch = Array.isArray(payload.data) ? payload.data : [];
            all = all.concat(batch);
            const total = (payload.meta && payload.meta.total) || all.length;
            if (batch.length === 0 || all.length >= total) break;
        }
        const headers = ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Taxable', 'GST', 'Total', 'Status'];
        const csv = rowsToCsv(headers, all, (r) => [
            fmtDate(r.invoice_date), r.customer || '', 'Sales', r.invoice_no,
            Number(r.taxable || 0).toFixed(2), Number(r.tax_amount || 0).toFixed(2),
            Number(r.total || 0).toFixed(2), txStatusLabel(r.status),
        ]);
        return sendCsv(res, month ? `sales-${month}.csv` : 'sales-invoices.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Export Purchase Register (month-wise, as shown) ── */
router.get('/purchase-invoices/register/export', async (req, res, next) => {
    try {
        const { rows: months, meta } = await apiList(req, '/purchase-invoices/monthly');
        const grand = (meta && meta.grand_total) || 0;
        const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const mlabel = (ym) => { const p = String(ym).split('-'); return (MN[Number(p[1])] || ym) + ' ' + p[0]; };
        const headers = ['Month', 'No. of Vouchers', 'Purchase Amount', 'Closing Balance'];
        let totalVch = 0;
        const records = (months || []).map((m) => {
            totalVch += Number(m.count) || 0;
            return [mlabel(m.month), m.count, Number(m.total).toFixed(2), Number(m.closing).toFixed(2)];
        });
        records.push(['Grand Total', totalVch, Number(grand).toFixed(2), Number(grand).toFixed(2)]);
        const csv = rowsToCsv(headers, records, (r) => r);
        return sendCsv(res, 'purchase-register.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Export a month's Purchase vouchers (drill-down) ── */
router.get('/purchase-invoices/export', async (req, res, next) => {
    try {
        const month = String(req.query.month || '').trim();
        let dateQs = '';
        if (/^\d{4}-\d{2}$/.test(month)) {
            const [yy, mm] = month.split('-').map(Number);
            const lastDay = new Date(yy, mm, 0).getDate();
            dateQs = `&date_from=${month}-01&date_to=${month}-${String(lastDay).padStart(2, '0')}`;
        }
        let all = [];
        for (let page = 1; page <= 200; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await api.get(req, `/purchase-invoices?per_page=100&page=${page}${dateQs}`);
            const payload = (result.body && result.body.data) || {};
            const batch = Array.isArray(payload.data) ? payload.data : [];
            all = all.concat(batch);
            const total = (payload.meta && payload.meta.total) || all.length;
            if (batch.length === 0 || all.length >= total) break;
        }
        const headers = ['Date', 'Particulars', 'Vch Type', 'Bill No.', 'Taxable', 'GST', 'Total', 'Status'];
        const csv = rowsToCsv(headers, all, (r) => [
            fmtDate(r.invoice_date), r.supplier || '', 'Purchase', r.invoice_no,
            Number(r.taxable || 0).toFixed(2), Number(r.tax_amount || 0).toFixed(2),
            Number(r.total || 0).toFixed(2), txStatusLabel(r.status),
        ]);
        return sendCsv(res, month ? `purchase-${month}.csv` : 'purchase-invoices.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Payment/Receipt Register exports (month-wise + drill) ── */
function makeRegisterExport(basePath, kind, amtLabel) {
    // basePath '/payments' or '/receipts'; kind 'Payment'/'Receipt'.
    return {
        register: async (req, res, next) => {
            try {
                const { rows: months, meta } = await apiList(req, `${basePath}/monthly`);
                const grand = (meta && meta.grand_total) || 0;
                const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
                const mlabel = (ym) => { const p = String(ym).split('-'); return (MN[Number(p[1])] || ym) + ' ' + p[0]; };
                const headers = ['Month', 'No. of Vouchers', amtLabel, 'Closing Balance'];
                let totalVch = 0;
                const records = (months || []).map((m) => {
                    totalVch += Number(m.count) || 0;
                    return [mlabel(m.month), m.count, Number(m.total).toFixed(2), Number(m.closing).toFixed(2)];
                });
                records.push(['Grand Total', totalVch, Number(grand).toFixed(2), Number(grand).toFixed(2)]);
                return sendCsv(res, `${kind.toLowerCase()}-register.csv`, rowsToCsv(headers, records, (r) => r));
            } catch (err) { next(err); }
        },
        list: async (req, res, next) => {
            try {
                const month = String(req.query.month || '').trim();
                let dateQs = '';
                if (/^\d{4}-\d{2}$/.test(month)) {
                    const [yy, mm] = month.split('-').map(Number);
                    const lastDay = new Date(yy, mm, 0).getDate();
                    dateQs = `&date_from=${month}-01&date_to=${month}-${String(lastDay).padStart(2, '0')}`;
                }
                let all = [];
                for (let page = 1; page <= 200; page += 1) {
                    // eslint-disable-next-line no-await-in-loop
                    const result = await api.get(req, `${basePath}?per_page=100&page=${page}${dateQs}`);
                    const payload = (result.body && result.body.data) || {};
                    const batch = Array.isArray(payload.data) ? payload.data : [];
                    all = all.concat(batch);
                    const total = (payload.meta && payload.meta.total) || all.length;
                    if (batch.length === 0 || all.length >= total) break;
                }
                const headers = ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Amount', 'Mode', 'Status'];
                const csv = rowsToCsv(headers, all, (r) => [
                    fmtDate(r.payment_date), r.party || '', kind, r.voucher_no,
                    Number(r.amount || 0).toFixed(2), r.mode || '', txStatusLabel(r.status),
                ]);
                return sendCsv(res, month ? `${kind.toLowerCase()}-${month}.csv` : `${kind.toLowerCase()}s.csv`, csv);
            } catch (err) { next(err); }
        },
    };
}
const _payExp = makeRegisterExport('/payments', 'Payment', 'Payment Amount');
const _rcpExp = makeRegisterExport('/receipts', 'Receipt', 'Receipt Amount');
router.get('/payments/register/export', _payExp.register);
router.get('/payments/export', _payExp.list);
router.get('/receipts/register/export', _rcpExp.register);
router.get('/receipts/export', _rcpExp.list);

/* ── TRANSACTIONS · Journal Register exports ── */
router.get('/journals/register/export', async (req, res, next) => {
    try {
        const { rows: months, meta } = await apiList(req, '/journals/monthly');
        const grand = (meta && meta.grand_total) || 0;
        const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const mlabel = (ym) => { const p = String(ym).split('-'); return (MN[Number(p[1])] || ym) + ' ' + p[0]; };
        const headers = ['Month', 'No. of Vouchers', 'Journal Amount', 'Closing Balance'];
        let totalVch = 0;
        const records = (months || []).map((m) => {
            totalVch += Number(m.count) || 0;
            return [mlabel(m.month), m.count, Number(m.total).toFixed(2), Number(m.closing).toFixed(2)];
        });
        records.push(['Grand Total', totalVch, Number(grand).toFixed(2), Number(grand).toFixed(2)]);
        return sendCsv(res, 'journal-register.csv', rowsToCsv(headers, records, (r) => r));
    } catch (err) { next(err); }
});
router.get('/journals/export', async (req, res, next) => {
    try {
        const month = String(req.query.month || '').trim();
        let dateQs = '';
        if (/^\d{4}-\d{2}$/.test(month)) {
            const [yy, mm] = month.split('-').map(Number);
            const lastDay = new Date(yy, mm, 0).getDate();
            dateQs = `&date_from=${month}-01&date_to=${month}-${String(lastDay).padStart(2, '0')}`;
        }
        let all = [];
        for (let page = 1; page <= 200; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await api.get(req, `/journals?per_page=100&page=${page}${dateQs}`);
            const payload = (result.body && result.body.data) || {};
            const batch = Array.isArray(payload.data) ? payload.data : [];
            all = all.concat(batch);
            const total = (payload.meta && payload.meta.total) || all.length;
            if (batch.length === 0 || all.length >= total) break;
        }
        const headers = ['Date', 'Vch No.', 'Dr Ledger', 'Cr Ledger', 'Amount', 'Narration', 'Status'];
        const csv = rowsToCsv(headers, all, (r) => [
            fmtDate(r.journal_date), r.voucher_no, r.dr_ledger, r.cr_ledger,
            Number(r.amount || 0).toFixed(2), r.narration || '', txStatusLabel(r.status),
        ]);
        return sendCsv(res, month ? `journal-${month}.csv` : 'journals.csv', csv);
    } catch (err) { next(err); }
});

/* ── MASTERS · Edit Company (GET /companies/:id/edit) ───────── */
router.get('/companies/:id/edit', async (req, res, next) => {
    try {
        const { body } = await api.get(req, `/companies/${req.params.id}`);
        const company = (body && body.data) || null;
        if (!company) { setFlash(req, 'error', 'Company not found.'); return req.session.save(() => res.redirect('/companies')); }
        const config = await fetchConfig(req, ['financial_years']);
        res.render('companies/form', {
            title: 'Edit Company',
            activeMenu: 'companies',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Companies', href: '/companies' },
                { label: 'Edit Company' },
            ],
            company, editId: company.id,
            ...config,
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Update Company (POST /companies/:id) ─────────── */
router.post('/companies/:id', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, mobile: b.mobile || null, phone: b.phone || null, email: b.email || null,
            gst_number: b.gst_number || null, pan_number: b.pan_number || null,
            mailing_name: b.mailing_name || null, state: b.state || null,
            country: b.country || null, pincode: b.pincode || null,
            financial_year: b.financial_year || null, books_from: b.books_from || null,
            address: b.address || null, status: b.status || 'Active',
            custom_fields: assembleCustomFields(b),
        };
        const result = await api.put(req, `/companies/${req.params.id}`, payload);
        if (apiOk(result)) {
            try {
                const mc = await api.get(req, '/my-companies');
                if (mc.body && mc.body.data && Array.isArray(mc.body.data.data)) {
                    req.session.companies = mc.body.data.data.map((c) => ({ id: c.id, name: c.name }));
                }
            } catch (_) { /* non-fatal */ }
            setFlash(req, 'success', 'Company updated successfully.');
            return req.session.save(() => res.redirect('/companies'));
        }
        setFlash(req, 'error', apiError(result, 'Could not update the company.'));
        return req.session.save(() => res.redirect(`/companies/${req.params.id}/edit`));
    } catch (err) { next(err); }
});

/* ── MASTERS · Delete Company (POST /companies/:id/delete) ──── */
router.post('/companies/:id/delete', async (req, res, next) => {
    try {
        const result = await api.del(req, `/companies/${req.params.id}`);
        if (apiOk(result)) {
            try {
                const mc = await api.get(req, '/my-companies');
                if (mc.body && mc.body.data && Array.isArray(mc.body.data.data)) {
                    req.session.companies = mc.body.data.data.map((c) => ({ id: c.id, name: c.name }));
                }
            } catch (_) { /* non-fatal */ }
            setFlash(req, 'success', 'Company deleted.');
        } else {
            setFlash(req, 'error', apiError(result, 'Could not delete the company.'));
        }
        return req.session.save(() => res.redirect('/companies'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Locations listing (GET /locations) ───────────── */
router.get('/locations', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/locations');
        const locationRows = rows.map((r) => {
            let cf = {};
            try { cf = (typeof r.custom_fields === 'string') ? JSON.parse(r.custom_fields || '{}') : (r.custom_fields || {}); } catch (_) { cf = {}; }
            const cfRows = Object.keys(cf).map((k) => ({ label: k, value: String(cf[k] || '—') }));
            return {
                id: r.id, name: r.name, code: r.code, city: r.city, state: r.state,
                mobile: r.mobile, manager: r.manager, customers: r.customers || '',
                status: r.status, created_at: fmtDate(r.created_at),
                // Full tab-wise detail for the View popup.
                _detail: [
                    { group: 'Basic Information' },
                    { label: 'Location Name', value: r.name || '—' },
                    { label: 'Location Code', value: r.code || '—' },
                    { label: 'Status', value: r.status || '—' },
                    { label: 'Is Tally Godown', value: r.is_tally_godown ? 'Yes' : 'No' },
                    { group: 'Address' },
                    { label: 'City', value: r.city || '—' },
                    { label: 'State', value: r.state || '—' },
                    { label: 'Pincode', value: r.pincode || '—' },
                    { group: 'Contact & Manager' },
                    { label: 'Mobile', value: r.mobile || '—' },
                    { label: 'Manager / In-charge', value: r.manager || '—' },
                ].concat(cfRows.length ? [{ group: 'Custom Fields' }].concat(cfRows) : []),
            };
        });
        res.render('locations/list', {
            title: 'Locations',
            activeMenu: 'locations',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Locations' }],
            locationRows, locationsTotal: meta.total, page: meta.page, perPage: meta.per_page,
            // Real states actually present in this org's locations (was mock).
            states: [...new Set(rows.map((r) => r.state).filter(Boolean))].sort(),
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
            custom_fields: assembleCustomFields(b),
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
        const locOpts = await fetchOptions(req, '/locations');   // real org locations
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
            locationNames: locOpts.map((o) => o.name),
        });
    } catch (err) { next(err); }
});

/* ── MASTERS · Add Sales Person (GET /sales-persons/add) ──────
 * Real locations (Assigned-Locations cards) + assignable roles (login role
 * select). Customer-Assign is edit-only (needs a saved sales person + its
 * assigned locations), so add-mode shows the "save first" hint. */
router.get('/sales-persons/add', async (req, res, next) => {
    try {
        const [locationOptions, roleOptions] = await Promise.all([
            fetchLocationCards(req),
            fetchRoleOptions(req),
        ]);
        res.render('sales-persons/form', {
            title: 'Add Sales Person',
            activeMenu: 'sales',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Sales Persons', href: '/sales-persons' },
                { label: 'Add Sales Person' },
            ],
            locationOptions,
            roleOptions,
        });
    } catch (err) { next(err); }
});

/* ── POST /sales-persons — create via api, then (best-effort) link a login
 * user and replace the assigned locations. On success we redirect to the EDIT
 * page so the operator can immediately assign per-location customers. */
router.post('/sales-persons', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, employee_code: b.employee_code || undefined,
            mobile: b.mobile || undefined, email: b.email || undefined,
            joining_date: b.joining_date || undefined, status: b.status || 'Active',
        };
        const result = await api.post(req, '/sales-persons', payload);
        if (!apiOk(result)) {
            setFlash(req, 'error', apiError(result, 'Could not create sales person.'));
            return req.session.save(() => res.redirect('/sales-persons/add'));
        }
        const id = result.body.data && result.body.data.id;

        // Assigned locations + (optional) login. Collect any warnings so the
        // operator knows if a login could not be created (dup email / seat cap).
        const warnings = [];
        let loginNote = '';
        if (id) {
            const locRes = await applySalesPersonLocations(req, id, b);
            if (!locRes.ok) warnings.push(locRes.msg);

            const loginRes = await applySalesPersonLogin(req, id, b);
            if (loginRes && !loginRes.ok) warnings.push(loginRes.msg);
            // The api's success msg carries the seat-limit "created Inactive" note
            // when over max_users — surface it so the operator isn't surprised.
            else if (loginRes && loginRes.ok && loginRes.msg) loginNote = loginRes.msg;
        }

        if (warnings.length) {
            setFlash(req, 'error', 'Sales person created, but: ' + warnings.join(' '));
        } else {
            setFlash(req, 'success',
                'Sales person created successfully. ' + (loginNote || 'Now assign their customers per location.'));
        }
        // To the edit page so the per-location customer checklists are available.
        return req.session.save(() => res.redirect(id ? `/sales-persons/${id}/edit` : '/sales-persons'));
    } catch (err) { next(err); }
});

/* ── SETTINGS · Customer Users (customer portal logins) ───────
 * A customer gets a LOGIN (like a sales person) + an assigned catalog:
 * categories with per-category Discount % / Addition %, optionally narrowed to
 * specific products. The linked login sees ONLY that catalog at the locked
 * adjusted rate and creates invoices that enter the approval queue. */
router.get('/customer-users', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/customers');
        const customerUserRows = rows.map((r) => ({
            id: r.id, name: r.name, mobile: r.mobile || '', email: r.email || '',
            group: r.customer_group || '',
            login: r.user_id ? 'Yes' : 'No',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('customer-users/list', {
            title: 'Customer Users',
            activeMenu: 'customer-users',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Customer Users' }],
            customerUserRows, customerUsersTotal: meta.total, page: meta.page, perPage: meta.per_page,
        });
    } catch (err) { next(err); }
});

/* Edit screen: login card + catalog (categories × pricing % × product ticks). */
router.get('/customer-users/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, roleOptions, catRes, prodRes] = await Promise.all([
            fetchRecord(req, '/customers', id),
            fetchRoleOptions(req),
            api.get(req, '/categories?per_page=100'),
            api.get(req, '/products?per_page=100'),
        ]);
        if (!record) { setFlash(req, 'error', 'Customer not found.'); return req.session.save(() => res.redirect('/customer-users')); }

        const categories = (catRes.body && catRes.body.data && Array.isArray(catRes.body.data.data)) ? catRes.body.data.data : [];
        const products   = (prodRes.body && prodRes.body.data && Array.isArray(prodRes.body.data.data)) ? prodRes.body.data.data : [];
        const productsByCategory = {};
        for (const p of products) {
            if (p.category_id == null) continue;
            const key = String(p.category_id);
            (productsByCategory[key] = productsByCategory[key] || []).push({
                id: p.id, name: p.name, sku: p.sku || '', sales_price: p.sales_price,
            });
        }

        // Saved assignments (login summary + catalog config) for prefill.
        let assignments = { user: null, categories: [] };
        try {
            const ar = await api.get(req, `/customers/${id}/assignments`);
            if (apiOk(ar) && ar.body.data) assignments = ar.body.data;
        } catch (_) { /* best-effort prefill */ }

        res.render('customer-users/form', {
            title: 'Configure Customer User',
            activeMenu: 'customer-users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Customer Users', href: '/customer-users' },
                { label: record.name || 'Configure' },
            ],
            record, roleOptions,
            categoryRows: categories.map((c) => ({ id: c.id, name: c.name })),
            productsByCategory,
            assignments,
        });
    } catch (err) { next(err); }
});

/* Save: forward the login (opt-in via login_email) to POST /customers/:id/login,
 * then the catalog to PUT /customers/:id/catalog. Both are API-enforced
 * (customers.edit + company scoping) — the UI is only a convenience layer. */
router.post('/customer-users/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const b  = req.body;
        const warnings = [];

        // Login (only when an email was supplied — password optional on update).
        const loginEmail = (b.login_email || '').trim();
        if (loginEmail) {
            const payload = { email: loginEmail, role_id: _num(b.role_id) };
            const pass = (b.password || '').trim();
            if (pass) payload.password = pass;
            if (b.login_status) payload.status = b.login_status;
            const lr = await api.post(req, `/customers/${id}/login`, payload);
            if (!apiOk(lr)) warnings.push(apiError(lr, 'Could not save the login.'));
        }

        // Catalog: cat_ids[] + disc[c<catId>] + add[c<catId>] + prod[c<catId>][].
        // The 'c' prefix keeps the maps OBJECT-keyed — a bare numeric key becomes
        // a sparse array index under the extended (qs) parser and gets COMPACTED,
        // silently losing which category a % belonged to (same trick as the
        // sales-person 'loc' keys).
        const catIds = toPosIntArray(b.cat_ids);
        const discMap = (b.disc && typeof b.disc === 'object') ? b.disc : {};
        const addMap  = (b.add  && typeof b.add  === 'object') ? b.add  : {};
        const prodMap = (b.prod && typeof b.prod === 'object') ? b.prod : {};
        const categories = catIds.map((catId) => ({
            category_id:  catId,
            discount_pct: Number(discMap['c' + catId]) || 0,
            addition_pct: Number(addMap['c' + catId])  || 0,
            product_ids:  toPosIntArray(prodMap['c' + catId]),
        }));
        const cr = await api.put(req, `/customers/${id}/catalog`, { categories });
        if (!apiOk(cr)) warnings.push(apiError(cr, 'Could not save the catalog.'));

        if (warnings.length) setFlash(req, 'error', warnings.join(' '));
        else setFlash(req, 'success', 'Customer user saved successfully.');
        return req.session.save(() => res.redirect(`/customer-users/${id}/edit`));
    } catch (err) { next(err); }
});

/* ── SETTINGS · Website Users (third-party API users) ─────────
 * A website user is a FRESH party + login + auto API token + cash/online
 * pricing %; catalog assignment reuses the /customers/:id/catalog API (a
 * website user IS a customers row under the hood). */
router.get('/website-users', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/website-users');
        const websiteUserRows = rows.map((r) => ({
            id: r.id, name: r.name, email: r.login_email || r.email || '', mobile: r.mobile || '',
            cash_pct: (Number(r.cash_extra_pct) || 0) + '%',
            online_pct: (Number(r.online_extra_pct) || 0) + '%',
            token: r.api_token ? (String(r.api_token).slice(0, 12) + '…') : '—',
            status: r.status, created_at: fmtDate(r.created_at),
        }));
        res.render('website-users/list', {
            title: 'Website Users',
            activeMenu: 'website-users',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Website Users' }],
            websiteUserRows, websiteUsersTotal: meta.total, page: meta.page, perPage: meta.per_page,
        });
    } catch (err) { next(err); }
});

router.get('/website-users/add', async (req, res, next) => {
    try {
        const roleOptions = await fetchRoleOptions(req);
        res.render('website-users/form', {
            title: 'Add Website User',
            activeMenu: 'website-users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Website Users', href: '/website-users' },
                { label: 'Add Website User' },
            ],
            record: null, roleOptions,
            categoryRows: [], productsByCategory: {}, assignments: { user: null, categories: [] },
        });
    } catch (err) { next(err); }
});

router.post('/website-users', async (req, res, next) => {
    try {
        const b = req.body;
        const payload = {
            name: b.name, email: (b.login_email || '').trim(), password: (b.password || '').trim(),
            role_id: _num(b.role_id), mobile: b.mobile || undefined,
            cash_extra_pct: Number(b.cash_extra_pct) || 0,
            online_extra_pct: Number(b.online_extra_pct) || 0,
            status: b.login_status || 'Active',
        };
        const result = await api.post(req, '/website-users', payload);
        if (!apiOk(result)) {
            setFlash(req, 'error', apiError(result, 'Could not create the website user.'));
            return req.session.save(() => res.redirect('/website-users/add'));
        }
        const id = result.body.data && result.body.data.id;
        setFlash(req, 'success', (result.body && result.body.msg) || 'Website user created.');
        // Straight to edit so the operator can copy the token + assign the catalog.
        return req.session.save(() => res.redirect(id ? `/website-users/${id}/edit` : '/website-users'));
    } catch (err) { next(err); }
});

router.get('/website-users/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [wuRes, roleOptions, catRes, prodRes] = await Promise.all([
            api.get(req, `/website-users/${id}`),
            fetchRoleOptions(req),
            api.get(req, '/categories?per_page=100'),
            api.get(req, '/products?per_page=100'),
        ]);
        const record = apiOk(wuRes) ? wuRes.body.data : null;
        if (!record) { setFlash(req, 'error', 'Website user not found.'); return req.session.save(() => res.redirect('/website-users')); }

        const categories = (catRes.body && catRes.body.data && Array.isArray(catRes.body.data.data)) ? catRes.body.data.data : [];
        const products   = (prodRes.body && prodRes.body.data && Array.isArray(prodRes.body.data.data)) ? prodRes.body.data.data : [];
        const productsByCategory = {};
        for (const p of products) {
            if (p.category_id == null) continue;
            const key = String(p.category_id);
            (productsByCategory[key] = productsByCategory[key] || []).push({
                id: p.id, name: p.name, sku: p.sku || '', sales_price: p.sales_price,
            });
        }
        let assignments = { user: record.login || null, categories: [] };
        try {
            const ar = await api.get(req, `/customers/${id}/assignments`);
            if (apiOk(ar) && ar.body.data) assignments = { user: record.login || ar.body.data.user, categories: ar.body.data.categories || [] };
        } catch (_) { /* best-effort prefill */ }

        res.render('website-users/form', {
            title: 'Configure Website User',
            activeMenu: 'website-users',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Website Users', href: '/website-users' },
                { label: record.name || 'Configure' },
            ],
            record, roleOptions,
            categoryRows: categories.map((c) => ({ id: c.id, name: c.name })),
            productsByCategory, assignments,
        });
    } catch (err) { next(err); }
});

router.post('/website-users/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const b  = req.body;
        const warnings = [];

        const payload = {
            name: b.name || undefined, mobile: b.mobile || undefined,
            cash_extra_pct: Number(b.cash_extra_pct) || 0,
            online_extra_pct: Number(b.online_extra_pct) || 0,
        };
        if ((b.login_email || '').trim()) payload.email = (b.login_email || '').trim();
        if (_num(b.role_id)) payload.role_id = _num(b.role_id);
        if ((b.password || '').trim()) payload.password = (b.password || '').trim();
        if (b.login_status) payload.status = b.login_status;
        const ur = await api.put(req, `/website-users/${id}`, payload);
        if (!apiOk(ur)) warnings.push(apiError(ur, 'Could not update the website user.'));

        // Catalog (same c-prefixed keys as the customer-users form).
        const catIds = toPosIntArray(b.cat_ids);
        const discMap = (b.disc && typeof b.disc === 'object') ? b.disc : {};
        const addMap  = (b.add  && typeof b.add  === 'object') ? b.add  : {};
        const prodMap = (b.prod && typeof b.prod === 'object') ? b.prod : {};
        const categories = catIds.map((catId) => ({
            category_id:  catId,
            discount_pct: Number(discMap['c' + catId]) || 0,
            addition_pct: Number(addMap['c' + catId])  || 0,
            product_ids:  toPosIntArray(prodMap['c' + catId]),
        }));
        const cr = await api.put(req, `/customers/${id}/catalog`, { categories });
        if (!apiOk(cr)) warnings.push(apiError(cr, 'Could not save the catalog.'));

        if (warnings.length) setFlash(req, 'error', warnings.join(' '));
        else setFlash(req, 'success', 'Website user saved successfully.');
        return req.session.save(() => res.redirect(`/website-users/${id}/edit`));
    } catch (err) { next(err); }
});

router.post('/website-users/:id/regenerate-token', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const r = await api.post(req, `/website-users/${id}/regenerate-token`, {});
        if (apiOk(r)) setFlash(req, 'success', 'API token regenerated. Old token stopped working.');
        else setFlash(req, 'error', apiError(r, 'Could not regenerate the token.'));
        return req.session.save(() => res.redirect(`/website-users/${id}/edit`));
    } catch (err) { next(err); }
});

/* ── MASTERS · Suppliers listing (GET /suppliers) ───────────── */
router.get('/suppliers', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/suppliers');
        const config = await fetchConfig(req, ['supplier_groups']);
        const locOpts = await fetchOptions(req, '/locations');   // real org locations
        const supplierRows = rows.map((r) => {
            let cf = {};
            try { cf = (typeof r.custom_fields === 'string') ? JSON.parse(r.custom_fields || '{}') : (r.custom_fields || {}); } catch (_) { cf = {}; }
            const cfRows = Object.keys(cf).map((k) => ({ label: k, value: String(cf[k] || '—') }));
            return {
                id: r.id, name: r.name, location: r.location || '', mobile: r.mobile,
                gst: r.gst_number || '', group: r.supplier_group || '',
                opening_balance: r.opening_balance, payment_terms: r.payment_terms || '',
                status: r.status, created_at: fmtDate(r.created_at),
                _detail: [
                    { group: 'Basic Information' },
                    { label: 'Supplier Name', value: r.name || '—' },
                    { label: 'Mobile', value: r.mobile || '—' },
                    { label: 'Alternate Mobile', value: r.alternate_mobile || '—' },
                    { label: 'Email', value: r.email || '—' },
                    { label: 'Supplier Group', value: r.supplier_group || '—' },
                    { label: 'Status', value: r.status || '—' },
                    { group: 'Tax & Statutory' },
                    { label: 'GST Number', value: r.gst_number || '—' },
                    { label: 'PAN Number', value: r.pan_number || '—' },
                    { group: 'Address' },
                    { label: 'Address', value: r.address || '—' },
                    { group: 'Other' },
                    { label: 'Opening Balance', value: (r.opening_balance != null ? String(r.opening_balance) : '—') },
                    { label: 'Payment Terms', value: r.payment_terms || '—' },
                    { label: 'Location', value: r.location || '—' },
                ].concat(cfRows.length ? [{ group: 'Custom Fields' }].concat(cfRows) : []),
            };
        });
        res.render('suppliers/list', {
            title: 'Suppliers',
            activeMenu: 'suppliers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Suppliers' }],
            supplierRows, suppliersTotal: meta.total, page: meta.page, perPage: meta.per_page,
            locationNames: locOpts.map((o) => o.name), ...config,
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
            email: b.email || undefined, gst_number: b.gst_number || undefined, pan_number: b.pan_number || undefined,
            supplier_group: b.supplier_group || undefined, location_id: num(b.location_id),
            opening_balance: num(b.opening_balance), payment_terms: b.payment_terms || undefined,
            address: b.address || undefined,
            status: b.status || 'Active', is_tally_ledger: asBool(b.is_tally_ledger),
            custom_fields: assembleCustomFields(b),
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
        const catOpts = await fetchOptions(req, '/categories');   // real org categories
        const productRows = rows.map((r) => {
            let cf = {};
            try { cf = (typeof r.custom_fields === 'string') ? JSON.parse(r.custom_fields || '{}') : (r.custom_fields || {}); } catch (_) { cf = {}; }
            const cfRows = Object.keys(cf).map((k) => ({ label: k, value: String(cf[k] || '—') }));
            return {
                id: r.id, name: r.name, image_url: r.image_url || null,
                images: Array.isArray(r.images) ? r.images.map((im) => im.url).filter(Boolean) : [],
                sku: r.sku || '', category: r.category || '',
                hsn: r.hsn_code || '', gst_rate: (r.gst_rate != null ? parseFloat(r.gst_rate) + '%' : ''),
                purchase_price: r.purchase_price, sales_price: r.sales_price,
                stock: r.opening_stock != null ? parseFloat(r.opening_stock) : '',
                status: r.status, created_at: fmtDate(r.created_at),
                _detail: [
                    { group: 'Basic Information' },
                    { label: 'Product Name', value: r.name || '—' },
                    { label: 'SKU / Item Code', value: r.sku || '—' },
                    { label: 'Category', value: r.category || '—' },
                    { label: 'Unit', value: r.unit || '—' },
                    { label: 'Status', value: r.status || '—' },
                    { group: 'Pricing & Tax' },
                    { label: 'HSN / SAC Code', value: r.hsn_code || '—' },
                    { label: 'GST Rate', value: (r.gst_rate != null ? parseFloat(r.gst_rate) + '%' : '—') },
                    { label: 'Purchase Price', value: (r.purchase_price != null ? String(r.purchase_price) : '—') },
                    { label: 'Sales Price', value: (r.sales_price != null ? String(r.sales_price) : '—') },
                    { group: 'Stock & Inventory' },
                    { label: 'Opening Stock', value: (r.opening_stock != null ? String(r.opening_stock) : '—') },
                    { group: 'Description' },
                    { label: 'Description', value: r.description || '—' },
                ].concat(cfRows.length ? [{ group: 'Custom Fields' }].concat(cfRows) : []),
            };
        });
        res.render('products/list', {
            title: 'Products',
            activeMenu: 'products',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Products' }],
            productRows, productsTotal: meta.total, page: meta.page, perPage: meta.per_page,
            categoryNames: catOpts.map((o) => o.name), ...config,
        });
    } catch (err) { next(err); }
});

/* ── CASH & BANK ─────────────────────────────────────────────────
 * /cash and /bank are the same screen over two buckets: a total header,
 * a financial-year range picker, and a Name | Balance table whose rows
 * open that ledger's statement. Balances are period-derived by the API
 * (replayed from the synced double entry), so the range really works.
 * ─────────────────────────────────────────────────────────────── */
const LEDGER_BUCKETS = {
    cash:        { title: 'Cash', menu: 'cash' },
    bank:        { title: 'Bank', menu: 'bank-ledgers' },
    payables:    { title: 'Payables', menu: 'suppliers' },
    receivables: { title: 'Receivables', menu: 'customers' },
};

// A super-admin has no tenant database bound, so every tally_* query would
// 500. They are a platform operator — their landing screen is Licenses.
function ledgerScreenBarred(res) {
    return !!res.locals.isSuperAdmin;
}

async function renderLedgerBucket(req, res, next, bucket) {
    try {
        if (ledgerScreenBarred(res)) return res.redirect('/licenses');
        const meta = LEDGER_BUCKETS[bucket];
        const now   = new Date();
        const range = resolveRange(String(req.query.range || DEFAULT_RANGE), now);

        const { rows, meta: listMeta } = await apiList(
            req, `/tally/ledgers?group=${bucket}&from=${range.from}&to=${range.to}`);

        const grp = (v) => Number(v || 0).toLocaleString('en-IN',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        res.render('ledgers/bucket', {
            title: meta.title,
            activeMenu: meta.menu,
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: meta.title }],
            bucket,
            ranges: buildRanges(now),
            range,
            totalAmount: '₹' + grp(listMeta.total_amount),
            totalDc: listMeta.total_dc || '',
            rows: rows.map((r) => ({
                name:    r.name,
                parent:  r.parent,
                balance: '₹' + grp(r.balance),
                dc:      r.dc,
                href:    `/ledgers/${encodeURIComponent(r.name)}?range=${range.value}`,
            })),
            meta: listMeta,
        });
    } catch (err) { next(err); }
}

router.get('/cash',        (req, res, next) => renderLedgerBucket(req, res, next, 'cash'));
router.get('/bank',        (req, res, next) => renderLedgerBucket(req, res, next, 'bank'));
router.get('/payables',    (req, res, next) => renderLedgerBucket(req, res, next, 'payables'));
router.get('/receivables', (req, res, next) => renderLedgerBucket(req, res, next, 'receivables'));

/* ── Ledger statement (GET /ledgers/:name) ──────────────────────
 * One ledger's voucher-wise movement for a period, with the opening /
 * closing pair Tally prints. Reached from /cash, /bank and the dashboard
 * Summary tiles. */
router.get('/ledgers/:name', async (req, res, next) => {
    try {
        if (ledgerScreenBarred(res)) return res.redirect('/licenses');
        const name  = String(req.params.name || '');
        const now   = new Date();
        const range = resolveRange(String(req.query.range || DEFAULT_RANGE), now);
        const vType = String(req.query.voucher_type || '');
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);

        const qs = new URLSearchParams({
            from: range.from, to: range.to, page: String(page), per_page: '20',
        });
        if (vType) qs.set('voucher_type', vType);

        const { body } = await api.get(req,
            `/tally/ledgers/${encodeURIComponent(name)}/statement?${qs.toString()}`);
        const data = (body && body.data) || {};
        if (!data.ledger) {
            setFlash(req, 'error', 'That ledger was not found.');
            return res.redirect('/cash');
        }

        const grp = (v) => Number(v || 0).toLocaleString('en-IN',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const bal = data.balance || {};

        res.render('ledgers/statement', {
            title: data.ledger.name,
            activeMenu: 'cash',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: data.ledger.name }],
            ledger: data.ledger,
            ranges: buildRanges(now),
            range,
            voucherTypes: Array.isArray(data.voucher_types) ? data.voucher_types : [],
            voucherType: vType,
            opening: '₹' + grp(bal.opening_amount), openingDc: bal.opening_dc || '',
            closing: '₹' + grp(bal.closing_amount), closingDc: bal.closing_dc || '',
            rows: (Array.isArray(data.data) ? data.data : []).map((r) => ({
                voucher: r.voucher_no,
                type:    r.voucher_type,
                date:    fmtDate(r.voucher_date),
                amount:  '₹' + grp(r.amount),
                dc:      r.dc,
                href:    r.voucher_guid ? `/vouchers/${encodeURIComponent(r.voucher_guid)}` : null,
            })),
            meta: (data.meta || { total: 0, page: 1, per_page: 20 }),
        });
    } catch (err) { next(err); }
});

/* ── Voucher detail (GET /vouchers/:guid) ───────────────────────
 * A Tally-origin voucher: its complete double entry plus any item
 * movement. Read-only — these rows are mirrored FROM Tally, so an Edit
 * action here would imply changes flow back, which they do not. When the
 * same voucher also exists as a cloud invoice we send the user to that
 * editable view instead. */
router.get('/vouchers/:guid', async (req, res, next) => {
    try {
        if (ledgerScreenBarred(res)) return res.redirect('/licenses');
        const guid = String(req.params.guid || '');

        const { body } = await api.get(req, `/tally/vouchers/${encodeURIComponent(guid)}`);
        const data = (body && body.data) || {};
        if (!data.voucher) {
            setFlash(req, 'error', 'That voucher was not found.');
            return res.redirect('/cash');
        }

        // Cloud-origin voucher → the real, editable invoice screen.
        if (data.invoice && data.invoice.id) {
            const base = data.invoice.type === 'purchase' ? '/purchase-invoices' : '/sales-invoices';
            return res.redirect(`${base}/${data.invoice.id}/edit`);
        }

        const grp = (v) => Number(v || 0).toLocaleString('en-IN',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const qty = (v) => Number(v || 0).toLocaleString('en-IN',
            { minimumFractionDigits: 0, maximumFractionDigits: 3 });
        const v = data.voucher;

        res.render('ledgers/voucher', {
            title: v.voucher_no || 'Voucher',
            activeMenu: 'cash',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: v.voucher_no || 'Voucher' }],
            voucher: {
                no:    v.voucher_no,
                type:  v.voucher_type,
                date:  fmtDate(v.voucher_date),
                party: v.party,
                totalDebit:  '₹' + grp(v.total_debit),
                totalCredit: '₹' + grp(v.total_credit),
            },
            entries: (data.entries || []).map((e) => ({
                ledger: e.ledger,
                amount: '₹' + grp(e.amount),
                dc:     e.dc,
            })),
            items: (data.items || []).map((it) => ({
                sr: it.sr, name: it.name, godown: it.godown,
                qty: qty(it.qty), rate: '₹' + grp(it.rate), amount: '₹' + grp(it.amount),
            })),
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
            custom_fields: assembleCustomFields(b),
        };
        const result = await api.post(req, '/products', payload);
        if (apiOk(result)) {
            const newId = result.body && result.body.data && result.body.data.id;
            setFlash(req, 'success', 'Product created — add images below (optional).');
            // Land on the edit page so images (which need a saved product id) can be
            // added right away, instead of bouncing back to the list.
            return req.session.save(() => res.redirect(newId ? `/products/${newId}/edit` : '/products'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create product.'));
        return req.session.save(() => res.redirect('/products/add'));
    } catch (err) { next(err); }
});

/* ── MASTERS · Categories listing (GET /categories) ─────────── */
router.get('/categories', async (req, res, next) => {
    try {
        const { rows, meta } = await apiList(req, '/categories');
        const catOpts = await fetchOptions(req, '/categories');   // real org categories (for Parent filter)
        const categoryRows = rows.map((r) => ({
            id: r.id, name: r.name, parent: r.parent || '—', products: r.products || '',
            status: r.status, created_at: fmtDate(r.created_at),
            _detail: [
                { group: 'Basic Information' },
                { label: 'Category Name', value: r.name || '—' },
                { label: 'Parent Category', value: r.parent || '—' },
                { label: 'Status', value: r.status || '—' },
            ],
        }));
        res.render('categories/list', {
            title: 'Categories',
            activeMenu: 'categories',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Categories' }],
            categoryRows, categoriesTotal: meta.total, page: meta.page, perPage: meta.per_page,
            categoryNames: catOpts.map((o) => o.name),
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
    const month = String(req.query.month || '').trim();

    // ── NO MONTH ──
    if (!/^\d{4}-\d{2}$/.test(month)) {
        const approval = String(req.query.approval || '').trim();
        // A non-approved tab (Pending / All) → a FLAT list across every month, so a
        // salesman can find their pending invoices without knowing the month.
        if (approval && approval !== 'approved') {
            const { rows, meta } = await apiList(req, '/sales-invoices');
            const _viewerIsAdmin = !!(res.locals.isCompanyAdmin || res.locals.isSuperAdmin);
            const invoiceRows = rows.map((r) => ({
                id: r.id, invoice_no: r.invoice_no, date: fmtDate(r.invoice_date), vch_type: 'Sales',
                customer: r.customer || '', location: r.location || '',
                amount: r.taxable, gst: r.tax_amount, total: r.total,
                status: txStatusLabel(r.status), sales_person: r.sales_person || '',
                approval: r.approval_status || 'approved',
                _lockActions: !_viewerIsAdmin && (r.approval_status === 'approved'),
            }));
            return res.render('sales-invoices/list', {
                title: 'Sales Invoices', activeMenu: 'sales-inv',
                breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Sales Invoices' }],
                invoiceRows, invoicesTotal: meta.total, grandTotal: meta.grand_total || 0,
                page: meta.page, perPage: meta.per_page,
                monthMode: false, approvalTab: approval, monthValue: '',
                customerNames: mock.customerNames, locationNames: mock.locationNames, invoiceStatuses: mock.invoiceStatuses,
            });
        }
        // Tally Sales-Register: month-wise summary of the APPROVED (real) sales.
        const { rows: monthRows, meta: mMeta } = await apiList(req, '/sales-invoices/monthly');
        // Count of invoices still awaiting approval (for the register banner/link).
        let pendingCount = 0;
        try {
            const p = await apiList(req, '/sales-invoices?approval=pending');
            pendingCount = (p.meta && p.meta.total != null) ? p.meta.total : (p.rows ? p.rows.length : 0);
        } catch (_) { /* non-fatal */ }
        return res.render('sales-invoices/register', {
            title: 'Sales Register',
            activeMenu: 'sales-inv',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Sales Invoices' },
            ],
            months:     monthRows,
            grandTotal: mMeta.grand_total || 0,
            pendingCount,
        });
    }

    // ── MONTH SELECTED → that month's voucher list (Tally Voucher Register) ──
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    req.query.date_from = `${month}-01`;
    req.query.date_to   = `${month}-${String(lastDay).padStart(2, '0')}`;
    const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = `${MN[mm]} ${yy}`;

    const { rows, meta } = await apiList(req, '/sales-invoices');
    // Once an invoice is APPROVED it counts + syncs to Tally, so a non-admin can
    // no longer edit/delete it — lock those row actions (admins stay unlocked).
    const _viewerIsAdmin = !!(res.locals.isCompanyAdmin || res.locals.isSuperAdmin);
    const invoiceRows = rows.map((r) => ({
        id: r.id, invoice_no: r.invoice_no, date: fmtDate(r.invoice_date),
        vch_type: 'Sales',
        customer: r.customer || '', location: r.location || '',
        amount: r.taxable, gst: r.tax_amount, total: r.total,
        status: txStatusLabel(r.status), sales_person: r.sales_person || '',
        approval: r.approval_status || 'approved',
        _lockActions: !_viewerIsAdmin && (r.approval_status === 'approved'),
    }));
    res.render('sales-invoices/list', {
        title: 'Sales Invoices · ' + monthLabel,
        activeMenu: 'sales-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Register', href: '/sales-invoices' },
            { label: monthLabel },
        ],

        invoiceRows,
        invoicesTotal:  meta.total,
        grandTotal:     meta.grand_total || 0,
        page:           meta.page,
        perPage:        meta.per_page,
        monthMode:      true,
        monthLabel,
        monthValue:     month,
        // SFA approval tab: 'approved' (default — real sales) | 'pending' | 'all'.
        approvalTab:    String(req.query.approval || 'approved'),

        // Filter option sources.
        customerNames:  mock.customerNames,
        locationNames:  mock.locationNames,
        invoiceStatuses: mock.invoiceStatuses,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Quotations (list) ─────────────────────────
 * GET /quotations — same shape as the sales-invoice list route.
 * `?mine=1` is the "My Quotations" entry (My Entries menu) — forwarded to the
 * api via the basePath query string (apiList() does not special-case it),
 * same trick the Approvals screen uses for `?approval=pending`.
 * `quote_status` is the quotation-specific deal-status filter (open/accepted/
 * rejected/expired) — QuotationController.list reads that exact param name. */
router.get('/quotations', async (req, res, next) => {
  try {
    const mineRaw = String(req.query.mine || '');
    const mine = mineRaw === '1' || mineRaw.toLowerCase() === 'true';
    const quoteStatus = String(req.query.quote_status || '').trim();

    let basePath = '/quotations';
    const qsParts = [];
    if (mine) qsParts.push('mine=1');
    if (quoteStatus) qsParts.push('quote_status=' + encodeURIComponent(quoteStatus));
    if (qsParts.length) basePath += '?' + qsParts.join('&');

    const { rows, meta } = await apiList(req, basePath);
    const todayIso = new Date().toISOString().slice(0, 10);
    const quotationRows = rows.map((r) => ({
        id: r.id,
        customer: r.customer || '',
        date: fmtDate(r.quotation_date),
        quotation_no: r.quotation_no,
        valid_till: fmtDate(r.valid_till),
        amount: r.total,
        status: r.quote_status || 'open',
    }));

    res.render('quotations/list', {
        title: mine ? 'My Quotations' : 'Quotations',
        activeMenu: mine ? 'my-quotations' : 'quotations',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: mine ? 'My Quotations' : 'Quotations' },
        ],
        quotationRows,
        quotationsTotal: meta.total,
        page:    meta.page,
        perPage: meta.per_page,
        mine,
        quoteStatus,
        today: todayIso,
    });
  } catch (err) { next(err); }
});

/* GET /quotations/:id/pdf — stream the api's rendered PDF straight through
 * (same pattern as /einvoices/:id/download → api.fetchBinary). */
router.get('/quotations/:id/pdf', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await api.fetchBinary(req, `/quotations/${id}/pdf`);
    if (r.status !== 200 || !r.buffer) {
        setFlash(req, 'error', 'Could not generate the quotation PDF.');
        return req.session.save(() => res.redirect('/quotations'));
    }
    res.setHeader('Content-Type', r.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quotation-${id}.pdf"`);
    return res.end(r.buffer);
  } catch (err) { next(err); }
});

/* POST /quotations/:id/convert — turns the quotation into a Sales Invoice;
 * on success send the user straight into the freshly-created invoice. */
router.post('/quotations/:id/convert', async (req, res, next) => {
  try {
    const result = await api.post(req, `/quotations/${req.params.id}/convert`, {});
    if (apiOk(result)) {
        const body = result.body || {};
        const invoiceId = body.data && body.data.invoice_id;
        // /sales-invoices/:id/edit only serves DRAFT invoices — a freshly
        // converted invoice is NOT a draft, so that redirect 302s straight
        // back to the list with no clue which invoice was just created.
        // /sales-invoices/:id/print DOES render any invoice regardless of
        // status, but it's a layout:false print sheet that never shows the
        // flash banner (the flash-consuming middleware in index.js clears
        // the session flash on that very request, so the message would be
        // silently lost). The list view uses the shared layout that DOES
        // render flashes, so land there filtered/anchored to the new
        // invoice's number — identifiable AND the flash is actually seen.
        let invoiceNo = invoiceId;
        if (invoiceId) {
            const inv = await api.get(req, `/sales-invoices/${invoiceId}`).catch(() => null);
            if (inv && apiOk(inv) && inv.body.data && inv.body.data.invoice_no) invoiceNo = inv.body.data.invoice_no;
        }
        setFlash(req, 'success', invoiceId ? `Converted to invoice ${invoiceNo}.` : (body.message || 'Converted to invoice.'));
        const dest = invoiceId
            ? `/sales-invoices?approval=all&search=${encodeURIComponent(invoiceNo)}`
            : '/quotations';
        return req.session.save(() => res.redirect(dest));
    }
    setFlash(req, 'error', apiError(result, 'Could not convert this quotation.'));
    return req.session.save(() => res.redirect('/quotations'));
  } catch (err) { next(err); }
});

/* POST /quotations/:id/delete — soft delete, matches the sales-invoice /
 * expenses delete-route style used by partials/table.ejs's row-delete confirm. */
router.post('/quotations/:id/delete', async (req, res, next) => {
  try {
    const result = await api.del(req, `/quotations/${req.params.id}`);
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Quotation deleted.')
                      : apiError(result, 'Could not delete the quotation.'));
    return req.session.save(() => res.redirect('/quotations'));
  } catch (err) { next(err); }
});

/* Parse the hidden items_json from a QUOTATION form into the api's item
 * shape. Quotation items carry two fields invoices don't (`godown`,
 * `tax_inclusive`) — parseInvoiceItems() drops them, so this is its own
 * small parser rather than a change to that shared helper. */
function parseQuotationItems(raw) {
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.map((it) => ({
        product_id:    it.product_id ? Number(it.product_id) : undefined,
        description:   it.description || undefined,
        hsn:           it.hsn || undefined,
        quantity:      Number(it.quantity) || 0,
        unit:          it.unit || undefined,
        rate:          Number(it.rate) || 0,
        discount_pct:  Number(it.discount_pct) || 0,
        gst_rate:      Number(it.gst_rate) || 0,
        godown:        it.godown || undefined,
        tax_inclusive: !!it.tax_inclusive,
    })).filter((it) => it.quantity > 0);
}

/* ── TRANSACTIONS · Create Quotation (GET /quotations/create) — same option
 * sources as the invoice create screen (fetchCustomerInvoiceOptions gives
 * customer + their location; products carry the line-item defaults). */
router.get('/quotations/create', async (req, res, next) => {
  try {
    const [customerOptions, locationOptions, salesPersonOptions, invoiceProducts, salesLedgerOptions, ledgerGroupOptions] = await Promise.all([
        fetchCustomerInvoiceOptions(req),
        fetchOptions(req, '/locations'),
        fetchOptions(req, '/sales-persons'),
        fetchInvoiceProducts(req, 'sales_price'),
        fetchSalesLedgerOptions(req),
        fetchLedgerGroupOptions(req),
    ]);
    res.render('quotations/create', {
        title: 'Create Quotation',
        activeMenu: 'quotations',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Quotations', href: '/quotations' },
            { label: 'Create Quotation' },
        ],

        customerOptions, locationOptions, salesPersonOptions, invoiceProducts, salesLedgerOptions,
        ledgerGroupOptions, gstStates: GST_STATES, gstRegistrationTypes: GST_REGISTRATION_TYPES,
        nextQuotationNo: 'Auto-generated on save',

        pageScript: '<script src="/js/quotation.js" defer></script>',
    });
  } catch (err) { next(err); }
});

/* ── POST /quotations/create/quick-customer — "Create New Customer" row
 * pinned atop the Party combobox (Defect 4). AJAX/JSON only: creates the
 * customer via the SAME api the full Customers form uses, then hands back
 * {id,name} so quotation.js can insert+select it in-memory without a page
 * reload (the voucher already in progress must not be lost). Kept minimal —
 * name + the handful of obviously-useful optional fields the modal exposes;
 * everything else defaults exactly like POST /customers does. */
router.post('/quotations/create/quick-customer', async (req, res) => {
    try {
        const b = req.body || {};
        const payload = {
            name:        (b.name || '').trim(),
            mobile:      b.mobile || undefined,
            email:       b.email || undefined,
            gst_number:  b.gst_number || undefined,
            billing_address: b.billing_address || undefined,
            ledger_group:          b.ledger_group || undefined,
            opening_balance:       (b.opening_balance === '' || b.opening_balance == null) ? undefined : Number(b.opening_balance),
            opening_balance_type:  b.opening_balance_type || undefined,
            country:               b.country || undefined,
            state:                 b.state || undefined,
            pincode:               b.pincode || undefined,
            gst_registration_type: b.gst_registration_type || undefined,
        };
        if (!payload.name) {
            return res.status(422).json({ ok: false, error: 'Customer name is required.' });
        }
        const result = await api.post(req, '/customers', payload);
        if (apiOk(result) && result.body && result.body.data) {
            const row = result.body.data;
            return res.json({ ok: true, data: { id: row.id, name: row.name } });
        }
        return res.status(422).json({ ok: false, error: apiError(result, 'Could not create customer.') });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'Could not create customer.' });
    }
});

/* ── POST /quotations — create a quotation via the api. Header fields submit
 * normally; line items ride the hidden items_json (serialised by
 * /js/quotation.js). The api computes all totals inside a db transaction. */
router.post('/quotations', async (req, res, next) => {
    try {
        const b = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            customer_id:     num(b.customer_id),
            location_id:     num(b.location_id),
            sales_person_id: num(b.sales_person_id),
            quotation_no:    b.quotation_no || undefined,
            quotation_date:  b.quotation_date || undefined,
            valid_till:      b.valid_till || undefined,
            ledger_name:     b.ledger_name || undefined,
            notes:           b.notes || undefined,
            items:           parseQuotationItems(b.items_json),
        };
        const result = await api.post(req, '/quotations', payload);
        if (apiOk(result)) {
            const msg = (result.body && result.body.message)
                || `Quotation ${(result.body.data && result.body.data.quotation_no) || ''} created.`;
            setFlash(req, 'success', msg);
            return req.session.save(() => res.redirect('/quotations'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create quotation.'));
        return req.session.save(() => res.redirect('/quotations/create'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Create Sales Invoice (GET /sales-invoices/create) */
router.get('/sales-invoices/create', async (req, res, next) => {
  try {
    const [customerOptions, locationOptions, salesPersonOptions, invoiceProducts] = await Promise.all([
        // Rich customer options carry the customer's location so picking a
        // customer AUTO-fills the Location field (see create.ejs). A salesman's
        // /locations + /sales-persons both 403 (no view perm), so those two
        // fetches come back empty — handled below by auto-filling from the
        // customer + the salesman's own identity.
        fetchCustomerInvoiceOptions(req),
        fetchOptions(req, '/locations'),
        fetchOptions(req, '/sales-persons'),
        fetchInvoiceProducts(req, 'sales_price'),
    ]);
    // The logged-in salesman IS the sales person (login = salesman) — their role
    // can't list sales_persons, so pre-fill the field with their own identity.
    const u = res.locals.user || {};
    const mySalesPerson = (res.locals.isSalesman && u.sales_person_id)
        ? { id: u.sales_person_id, name: u.name || 'Me' }
        : null;
    res.render('sales-invoices/create', {
        title: 'Create Invoice',
        activeMenu: 'sales-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Invoices', href: '/sales-invoices' },
            { label: 'Create Invoice' },
        ],

        customerOptions, locationOptions, salesPersonOptions, invoiceProducts,
        mySalesPerson,
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
        // SFA — a salesman may "Save as Draft" (button posts save_as_draft=1)
        // instead of submitting for approval. Harmless for admins (api ignores it).
        const wantsDraft = b.save_as_draft === '1' || b.save_as_draft === 'true' || b.save_as_draft === 'on';
        const payload = {
            customer_id:     num(b.customer_id),
            location_id:     num(b.location_id),
            sales_person_id: num(b.sales_person_id),
            invoice_date:    b.invoice_date || undefined,
            due_date:        b.due_date || undefined,
            notes:           b.notes || undefined,
            save_as_draft:   wantsDraft ? true : undefined,
            items:           parseInvoiceItems(b.items_json),
        };
        const result = await api.post(req, '/sales-invoices', payload);
        if (apiOk(result)) {
            // Use the api's message ("Draft saved." / "Invoice submitted for
            // approval." / "Invoice created.") so the salesman sees the right one.
            const msg = (result.body && result.body.message)
                || `Invoice ${(result.body.data && result.body.data.invoice_no) || ''} created.`;
            setFlash(req, 'success', msg);
            // Salesmen land on their field dashboard; admins on the register.
            return req.session.save(() => res.redirect(res.locals.isSalesman ? '/my-field' : '/sales-invoices'));
        }
        setFlash(req, 'error', apiError(result, 'Could not create invoice.'));
        return req.session.save(() => res.redirect('/sales-invoices/create'));
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · EDIT a Sales Invoice (GET /sales-invoices/:id/edit) — reuses
 *    the create form pre-filled. Editable ONLY while un-approved (draft/pending/
 *    rejected); the api locks approved. A salesman may edit ONLY their own (api
 *    scopes by created_by). Saving re-submits it for approval. */
router.get('/sales-invoices/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [invR, customerOptions, locationOptions, salesPersonOptions, invoiceProducts] = await Promise.all([
        api.get(req, `/sales-invoices/${id}`),
        fetchCustomerInvoiceOptions(req),
        fetchOptions(req, '/locations'),
        fetchOptions(req, '/sales-persons'),
        fetchInvoiceProducts(req, 'sales_price'),
    ]);
    // GET /sales-invoices/:id returns the invoice fields at the ROOT of data,
    // with the line items nested under data.items.
    const inv = (invR.body && invR.body.data) || null;
    if (!inv || !inv.id) {
        setFlash(req, 'error', 'Invoice not found or you cannot edit it.');
        return req.session.save(() => res.redirect(res.locals.isSalesman ? '/my-approvals' : '/sales-invoices'));
    }
    if (String(inv.approval_status) === 'approved') {
        setFlash(req, 'error', 'This invoice is approved and locked — it can no longer be edited.');
        return req.session.save(() => res.redirect(res.locals.isSalesman ? '/my-approvals?status=approved' : '/sales-invoices'));
    }
    const u = res.locals.user || {};
    const mySalesPerson = (res.locals.isSalesman && u.sales_person_id)
        ? { id: u.sales_person_id, name: u.name || 'Me' } : null;
    res.render('sales-invoices/create', {
        title: 'Edit Invoice',
        activeMenu: 'sales-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Sales Invoices', href: res.locals.isSalesman ? '/my-approvals' : '/sales-invoices' },
            { label: 'Edit Invoice' },
        ],
        customerOptions, locationOptions, salesPersonOptions, invoiceProducts, mySalesPerson,
        nextInvoiceNo: inv.invoice_no || '',
        editInvoice: inv,
        editItems: Array.isArray(inv.items) ? inv.items : [],
        pageScript: '<script src="/js/invoice.js" defer></script>',
    });
  } catch (err) { next(err); }
});

/* POST /sales-invoices/:id/update — save an edited invoice (api PUT
 * /sales-invoices/:id → updateDraft). Saving without save_as_draft re-submits it
 * for approval (draft/rejected → pending). Salesman → back to My Approvals. */
router.post('/sales-invoices/:id/update', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    const num = (v) => (v === '' || v == null ? undefined : Number(v));
    const wantsDraft = b.save_as_draft === '1' || b.save_as_draft === 'true' || b.save_as_draft === 'on';
    const payload = {
        customer_id:     num(b.customer_id),
        location_id:     num(b.location_id),
        sales_person_id: num(b.sales_person_id),
        invoice_date:    b.invoice_date || undefined,
        due_date:        b.due_date || undefined,
        notes:           b.notes || undefined,
        save_as_draft:   wantsDraft ? true : false,   // explicit false → re-submit (pending)
        items:           parseInvoiceItems(b.items_json),
    };
    const result = await api.put(req, `/sales-invoices/${id}`, payload);
    if (apiOk(result)) {
        setFlash(req, 'success', (result.body && result.body.msg) || 'Invoice updated.');
        const dest = res.locals.isSalesman
            ? (wantsDraft ? '/my-approvals?status=draft' : '/my-approvals?status=pending')
            : '/sales-invoices';
        return req.session.save(() => res.redirect(dest));
    }
    setFlash(req, 'error', apiError(result, 'Could not update the invoice.'));
    return req.session.save(() => res.redirect(`/sales-invoices/${id}/edit`));
  } catch (err) { next(err); }
});

/* ── SFA · Invoice Approvals — pending field invoices for an admin to act on.
 *    (GET /sales-invoices/approvals) — must be a LITERAL path (no :id conflict). */
router.get('/sales-invoices/approvals', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { rows, meta } = await apiList(req, '/sales-invoices?approval=pending');
    const approvals = rows.map((r) => ({
        id:           r.id,
        invoice_no:   r.invoice_no,
        date:         fmtDate(r.invoice_date),
        customer:     r.customer || '',
        location:     r.location || '',
        sales_person: r.sales_person || '',
        total:        r.total,
    }));
    res.render('sales-invoices/approvals', {
        title: 'Invoice Approvals',
        activeMenu: 'approvals',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Invoice Approvals' },
        ],
        approvals,
        total:   meta.total != null ? meta.total : approvals.length,
        page:    meta.page || page,
        perPage: meta.per_page || 10,
    });
  } catch (err) { next(err); }
});

/* POST approve / reject a pending field invoice (admins with edit perm). */
router.post('/sales-invoices/:id/approve', async (req, res, next) => {
  try {
    const result = await api.post(req, `/sales-invoices/${req.params.id}/approve`, {});
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Invoice approved.')
                      : apiError(result, 'Could not approve the invoice.'));
    return req.session.save(() => res.redirect('/sales-invoices/approvals'));
  } catch (err) { next(err); }
});

router.post('/sales-invoices/:id/reject', async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const result = await api.post(req, `/sales-invoices/${req.params.id}/reject`, { reason });
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Invoice rejected.')
                      : apiError(result, 'Could not reject the invoice.'));
    return req.session.save(() => res.redirect('/sales-invoices/approvals'));
  } catch (err) { next(err); }
});

/* ── SFA · Salesman "My Field" dashboard (GET /my-field) — assigned locations +
 *    their customer/invoice tallies + approval-status counts. */
router.get('/my-field', async (req, res, next) => {
  try {
    const { body } = await api.get(req, '/field/my-dashboard');
    const field = (body && body.data) || { is_salesman: false, locations: [], stats: {} };
    res.render('field/my-dashboard', {
        title: 'My Field',
        activeMenu: 'my-field',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'My Field' },
        ],
        field,
    });
  } catch (err) { next(err); }
});

/* ── SFA · My Customers (GET /my-customers) — a salesman's OWN assigned
 *    customers, read-only. /customers is assignment-scoped server-side
 *    (canCustomerRead), so this lists ONLY the customers assigned to them. */
router.get('/my-customers', async (req, res, next) => {
  try {
    const { body } = await api.get(req, '/customers?per_page=100');
    const rows = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
    res.render('field/my-customers', {
        title: 'My Customers',
        activeMenu: 'my-field',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'My Field', href: '/my-field' },
            { label: 'My Customers' },
        ],
        customers: rows,
    });
  } catch (err) { next(err); }
});

/* ── SFA · My Locations (GET /my-locations) — a salesman's OWN assigned
 *    locations (beats), read-only, with their per-location tallies. Reuses the
 *    same /field/my-dashboard payload as the field home. */
router.get('/my-locations', async (req, res, next) => {
  try {
    const { body } = await api.get(req, '/field/my-dashboard');
    const field = (body && body.data) || { is_salesman: false, locations: [] };
    res.render('field/my-locations', {
        title: 'My Locations',
        activeMenu: 'my-field',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'My Field', href: '/my-field' },
            { label: 'My Locations' },
        ],
        field,
    });
  } catch (err) { next(err); }
});

/* ── SFA · My Approvals (GET /my-approvals) — the salesman's OWN invoices in ONE
 *    page, grouped by status (Pending / Approved / Rejected / Draft). The api's
 *    /sales-invoices is scoped to their own rows (created_by) + filters by
 *    ?approval=<status>. Pending & rejected & draft rows can be re-submitted
 *    (POST /sales-invoices/:id/submit); approved is view-only. */
router.get('/my-approvals', async (req, res, next) => {
  try {
    const want = ['pending', 'rejected', 'approved', 'draft'];
    const active = want.includes(String(req.query.status)) ? String(req.query.status) : 'pending';
    const lists = {};
    await Promise.all(want.map(async (s) => {
        try {
            const { body } = await api.get(req, `/sales-invoices?approval=${s}&per_page=100`);
            lists[s] = (body && body.data && Array.isArray(body.data.data)) ? body.data.data : [];
        } catch (_) { lists[s] = []; }
    }));
    res.render('field/my-approvals', {
        title: 'My Approvals',
        activeMenu: 'my-field',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'My Field', href: '/my-field' },
            { label: 'My Approvals' },
        ],
        lists, active,
    });
  } catch (err) { next(err); }
});

/* POST /sales-invoices/:id/resubmit — a salesman re-submits an edited/rejected
 * invoice for approval (api POST /sales-invoices/:id/submit). Scoped + gated
 * server-side (own, non-approved). Redirects back to My Approvals. */
router.post('/sales-invoices/:id/resubmit', async (req, res, next) => {
  try {
    const result = await api.post(req, `/sales-invoices/${Number(req.params.id)}/submit`, {});
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.msg) || 'Invoice re-submitted for approval.')
                      : apiError(result, 'Could not re-submit the invoice.'));
    return req.session.save(() => res.redirect('/my-approvals?status=pending'));
  } catch (err) { next(err); }
});

/* ── SFA Phase 2 · Field Tracking (GET /field-tracking) — GPS visit log.
 *    Admin sees the whole company; a salesman sees their own (api scopes it). */
router.get('/field-tracking', async (req, res, next) => {
  try {
    const date = (req.query.date || '').trim();
    const spId = String(req.query.sales_person_id || '').trim();
    // Build the shared query string (date + salesman) once — the API scopes a
    // salesman to their own visits regardless, so the filter only matters for admins.
    const params = [];
    if (date) params.push(`date=${encodeURIComponent(date)}`);
    if (spId) params.push(`sales_person_id=${encodeURIComponent(spId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    // Salesman list for the admin's filter dropdown (a salesman only sees self, so skip).
    const salesmenP = res.locals.isSalesman
        ? Promise.resolve({ body: { data: { data: [] } } })
        : api.get(req, '/sales-persons?per_page=200').catch(() => ({ body: { data: { data: [] } } }));
    const [visitsR, pingsR, salesmenR] = await Promise.all([
        api.get(req, `/field/visits${qs}`),
        api.get(req, `/field/locations${qs}`),
        salesmenP,
    ]);
    const rows = (visitsR.body && visitsR.body.data && Array.isArray(visitsR.body.data.data)) ? visitsR.body.data.data : [];
    const visits = rows.map((v) => ({
        id:              v.id,
        customer:        v.customer || '—',
        customer_mobile: v.customer_mobile || '',
        location:        v.location || '—',
        sales_person:    v.sales_person || '—',
        // Field tracking shows the full timestamp (date AND time) — a check-in at
        // 2:19 PM must read as such, not just the day.
        checkin:      fmtDateTime(v.checkin_at),
        checkout:     v.checkout_at ? fmtDateTime(v.checkout_at) : '',
        distance:     v.checkin_distance_m,
        within:       !!v.checkin_within,
        lat:          v.checkin_lat,
        lng:          v.checkin_lng,
        note:         v.note || '',
        status:       v.status,
    }));
    const prows = (pingsR.body && pingsR.body.data && Array.isArray(pingsR.body.data.data)) ? pingsR.body.data.data : [];
    const pings = prows.map((p) => ({
        sales_person: p.sales_person || '—',
        source:       p.source || '—',
        lat:          p.lat, lng: p.lng,
        moved:        p.moved_m,
        at:           fmtDateTime(p.captured_at),
    }));
    const srows = (salesmenR.body && salesmenR.body.data && Array.isArray(salesmenR.body.data.data)) ? salesmenR.body.data.data : [];
    const salesmen = srows.map((s) => ({ id: s.id, name: s.name }));
    res.render('field/tracking', {
        title: 'Field Tracking',
        activeMenu: 'field-tracking',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Field Tracking' },
        ],
        visits,
        pings,
        salesmen,
        date,
        salesPersonId: spId,
    });
  } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Purchase Invoices (GET /purchase-invoices) ─ */
router.get('/purchase-invoices', async (req, res, next) => {
  try {
    const month = String(req.query.month || '').trim();

    // ── NO MONTH → Tally Purchase-Register: month-wise summary (drill-down) ──
    if (!/^\d{4}-\d{2}$/.test(month)) {
        const { rows: monthRows, meta: mMeta } = await apiList(req, '/purchase-invoices/monthly');
        return res.render('purchase-invoices/register', {
            title: 'Purchase Register',
            activeMenu: 'purchase-inv',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Purchase Invoices' },
            ],
            months:     monthRows,
            grandTotal: mMeta.grand_total || 0,
        });
    }

    // ── MONTH SELECTED → that month's voucher list (Tally Voucher Register) ──
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    req.query.date_from = `${month}-01`;
    req.query.date_to   = `${month}-${String(lastDay).padStart(2, '0')}`;
    const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = `${MN[mm]} ${yy}`;

    const { rows, meta } = await apiList(req, '/purchase-invoices');
    const purchaseRows = rows.map((r) => ({
        id: r.id, bill_no: r.invoice_no, date: fmtDate(r.invoice_date),
        vch_type: 'Purchase',
        supplier: r.supplier || '', location: r.location || '',
        amount: r.taxable, gst: r.tax_amount, total: r.total,
        status: txStatusLabel(r.status),
    }));
    res.render('purchase-invoices/list', {
        title: 'Purchase Invoices · ' + monthLabel,
        activeMenu: 'purchase-inv',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Purchase Register', href: '/purchase-invoices' },
            { label: monthLabel },
        ],

        purchaseRows,
        purchasesTotal:  meta.total,
        grandTotal:      meta.grand_total || 0,
        page:            meta.page,
        perPage:         meta.per_page,
        monthMode:       true,
        monthLabel,
        monthValue:      month,

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
    const month = String(req.query.month || '').trim();

    // ── NO MONTH → Payment Register (month-wise summary, drill-down) ──
    if (!/^\d{4}-\d{2}$/.test(month)) {
        const { rows: monthRows, meta: mMeta } = await apiList(req, '/payments/monthly');
        return res.render('payments/register', {
            title: 'Payment Register',
            activeMenu: 'payments',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Payments' }],
            months:     monthRows,
            grandTotal: mMeta.grand_total || 0,
        });
    }

    // ── MONTH SELECTED → that month's voucher list ──
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    req.query.date_from = `${month}-01`;
    req.query.date_to   = `${month}-${String(lastDay).padStart(2, '0')}`;
    const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = `${MN[mm]} ${yy}`;

    const { rows, meta } = await apiList(req, '/payments');
    const config = await fetchConfig(req, ['payment_modes']);
    const paymentRows = rows.map((r) => ({
        id: r.id, payment_no: r.voucher_no, date: fmtDate(r.payment_date),
        vch_type: 'Payment',
        party: r.party || '', mode: r.mode || '', reference: r.reference || '—',
        amount: r.amount, status: txStatusLabel(r.status),
    }));
    res.render('payments/list', {
        title: 'Payments · ' + monthLabel,
        activeMenu: 'payments',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Payment Register', href: '/payments' },
            { label: monthLabel },
        ],

        paymentRows,
        paymentsTotal:   meta.total,
        grandTotal:      meta.grand_total || 0,
        page:            meta.page,
        perPage:         meta.per_page,
        monthMode:       true,
        monthLabel,
        monthValue:      month,

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
    const month = String(req.query.month || '').trim();

    // ── NO MONTH → Receipt Register (month-wise summary, drill-down) ──
    if (!/^\d{4}-\d{2}$/.test(month)) {
        const { rows: monthRows, meta: mMeta } = await apiList(req, '/receipts/monthly');
        return res.render('receipts/register', {
            title: 'Receipt Register',
            activeMenu: 'receipts',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Receipts' }],
            months:     monthRows,
            grandTotal: mMeta.grand_total || 0,
        });
    }

    // ── MONTH SELECTED → that month's voucher list ──
    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    req.query.date_from = `${month}-01`;
    req.query.date_to   = `${month}-${String(lastDay).padStart(2, '0')}`;
    const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = `${MN[mm]} ${yy}`;

    const { rows, meta } = await apiList(req, '/receipts');
    const config = await fetchConfig(req, ['payment_modes']);
    const receiptRows = rows.map((r) => ({
        id: r.id, receipt_no: r.voucher_no, date: fmtDate(r.payment_date),
        vch_type: 'Receipt',
        party: r.party || '', mode: r.mode || '', reference: r.reference || '—',
        amount: r.amount, status: txStatusLabel(r.status),
    }));
    res.render('receipts/list', {
        title: 'Receipts · ' + monthLabel,
        activeMenu: 'receipts',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Receipt Register', href: '/receipts' },
            { label: monthLabel },
        ],

        receiptRows,
        receiptsTotal:   meta.total,
        grandTotal:      meta.grand_total || 0,
        page:            meta.page,
        perPage:         meta.per_page,
        monthMode:       true,
        monthLabel,
        monthValue:      month,

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
        if (req.query.search)   qs.set('search', String(req.query.search));
        if (req.query.status)   qs.set('status', String(req.query.status));
        if (req.query.category) qs.set('category', String(req.query.category));
        if (req.query.sort)     qs.set('sort',  String(req.query.sort));
        if (req.query.order)    qs.set('order', String(req.query.order));

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
            category:  r.category || '',
            unit:      r.unit || '',
            location:  r.location || '',
            opening:   r.opening != null ? r.opening : 0,
            purchased: r.purchased != null ? r.purchased : 0,
            sold:      r.sold != null ? r.sold : 0,
            current:   r.current != null ? r.current : 0,
            value:     r.value != null ? r.value : 0,
            status:    r.status_label || '',
            // Tab-wise View popup (table.ejs reads row._detail).
            _detail: [
                { group: 'Item' },
                { label: 'Product', value: r.product || '—' },
                { label: 'SKU', value: r.sku || '—' },
                { label: 'Category', value: r.category || '—' },
                { label: 'Unit', value: r.unit || '—' },
                { label: 'HSN/SAC', value: r.hsn || '—' },
                { group: 'Stock Movement' },
                { label: 'Opening', value: r.opening != null ? r.opening : 0 },
                { label: 'Purchased (Inwards)', value: r.purchased != null ? r.purchased : 0 },
                { label: 'Sold (Outwards)', value: r.sold != null ? r.sold : 0 },
                { label: 'Current Stock', value: r.current != null ? r.current : 0 },
                { label: 'Stock Value', value: inr(r.value) },
                { label: 'Status', value: r.status_label || '—' },
            ],
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

            // Filter dropdown option sources — REAL org data.
            categoryNames: (await fetchOptions(req, '/categories')).map((o) => o.name),
            locationNames: (await fetchOptions(req, '/locations')).map((o) => o.name),
            stockStatuses: ['In Stock', 'Low Stock', 'Out of Stock'],
        });
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Export Inventory (GET /inventory/export) ── all columns ── */
router.get('/inventory/export', async (req, res, next) => {
    try {
        let all = [];
        for (let page = 1; page <= 200; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await api.get(req, `/inventory?per_page=100&page=${page}`);
            const payload = (result.body && result.body.data) || {};
            const batch = Array.isArray(payload.data) ? payload.data : [];
            all = all.concat(batch);
            const total = (payload.meta && payload.meta.total) || all.length;
            if (batch.length === 0 || all.length >= total) break;
        }
        const headers = ['Product', 'SKU', 'Category', 'Unit', 'HSN', 'Opening',
            'Purchased', 'Sold', 'Current Stock', 'Stock Value', 'Status'];
        const csv = rowsToCsv(headers, all, (r) => [
            r.product, r.sku, r.category, r.unit, r.hsn, r.opening,
            r.purchased, r.sold, r.current, Number(r.value || 0).toFixed(2), r.status_label,
        ]);
        return sendCsv(res, 'inventory.csv', csv);
    } catch (err) { next(err); }
});

/* ── TRANSACTIONS · Adjust a product's stock (GET /inventory/:id/edit) ──
 * The ⋮ "edit" action → the Stock Adjustment form pre-pointed at this product. */
router.get('/inventory/:id/edit', async (req, res, next) => {
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
            selectedProductId: Number(req.params.id) || null,
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

    // CONNECTION = 100% REAL, derived from the agent's last heartbeat. The api
    // computes `summary.connected` from licenses.last_seen_at (≤150s = live); we
    // re-apply the SAME freshness rule against the returned heartbeat timestamp
    // (heartbeat_at / last_seen_at) so a STALE or ABSENT heartbeat can never show
    // a fake "Connected" — it reads Disconnected/Offline, exactly like the License
    // detail page. We AND the two so it's connected only when BOTH agree.
    const heartbeatIso = summary.heartbeat_at || summary.last_seen_at || null;
    const connected = !!summary.connected && isHeartbeatFresh(heartbeatIso);
    // Date AND time everywhere "Last Sync" / heartbeat is shown. The heartbeat is
    // the REAL last_seen time (or '—' if the agent has never been seen) — NOT a
    // faked recent time when disconnected.
    const heartbeatTxt = heartbeatIso ? fmtDateTime(heartbeatIso) : '—';
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

    // Auto-sync toggles. The MASTER switch (sync_enabled) plus the per-direction
    // push/pull flags the agent loop honours; default ON when absent (matches the
    // api default). RAW values for the read-only Dashboard status line.
    const syncEnabled = summary.sync_enabled !== false;
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
        // Auto-sync toggles (live-reflected by /js/sync-dashboard.js): master
        // switch + per-direction. RAW values for the read-only status line.
        sync_enabled:     syncEnabled,
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
            // Auto-sync toggles (Requirement 1): master + per-direction.
            sync_enabled:     d.sync_enabled,
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
    // Per-module selection for AUTO push/pull. Accept either a real array (XHR
    // JSON) or a comma-joined string (plain form fallback). Only forward when
    // the client actually sent the field so a flag-only toggle never clears it.
    const asArr = (v) => (Array.isArray(v) ? v
        : (typeof v === 'string' && v !== '' ? v.split(',') : (v === '' ? [] : undefined)));
    if (b.push_modules !== undefined) { const a = asArr(b.push_modules); if (a !== undefined) payload.push_modules = a; }
    if (b.pull_modules !== undefined) { const a = asArr(b.pull_modules); if (a !== undefined) payload.pull_modules = a; }
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
                push_modules: data.push_modules, pull_modules: data.pull_modules,
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

/* ── NOTIFICATIONS · Full page (GET /notifications) ─────────────
 * The dedicated notifications screen: the whole feed (every module's cloud
 * actions + sync failures + agent updates) paginated, with Mark-all-read and a
 * click-through that opens the related page. Open to EVERY logged-in user. */
router.get('/notifications', async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const result = await api.get(req, `/sync/notifications/all?page=${page}&per_page=20`);
        // The api envelope is { status, data: { data:[…items], meta:{…} } } — the
        // items live at body.data.DATA (not body.data, which is the wrapper). This
        // was why the page rendered empty while the bell (reads .data.recent) had
        // items.
        const payload = (result && result.body && result.body.data) || {};
        const items = Array.isArray(payload.data) ? payload.data : [];
        const meta  = payload.meta || { total: items.length, page, per_page: 20, unread: 0 };
        res.render('notifications/index', {
            title: 'Notifications',
            activeMenu: 'notifications',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Notifications' }],
            items, meta, page,
        });
    } catch (err) { next(err); }
});

/* ── NOTIFICATIONS · Open one (GET /notifications/open?key=&to=) ──
 * Marks the item read (best-effort) then redirects to its target page. Used as
 * the href on every notification so it works WITHOUT JS too. `to` is restricted
 * to internal paths to avoid an open-redirect. */
router.get('/notifications/open', async (req, res) => {
    const key = req.query.key ? String(req.query.key) : '';
    let to    = req.query.to  ? String(req.query.to)  : '/';
    if (!/^\/[^/]/.test(to)) to = '/';                 // internal "/path" only
    if (key) { try { await api.post(req, '/sync/notifications/read', { key }); } catch (_) { /* best-effort */ } }
    return res.redirect(to);
});

/* ── NOTIFICATIONS · Mark ONE bell item read (POST /notifications/read) ──
 * Forwards the body { key } (a bell item id as text — a sync-log id, OR
 * "agent-update-<version>") to the api POST /sync/notifications/read, marking it
 * read for THIS user. Returns JSON { ok, unread } where `unread` is the fresh
 * read-aware badge count (body.data.unread). The header bell JS POSTs here as XHR
 * and uses `unread` to update the live badge. Authenticated like every route
 * below requireAuth above. */
router.post('/notifications/read', async (req, res) => {
    const key = (req.body && req.body.key != null) ? String(req.body.key) : '';
    if (!key) return res.status(200).json({ ok: false, unread: null, msg: 'A notification key is required.' });
    try {
        const result = await api.post(req, '/sync/notifications/read', { key });
        const ok = apiOk(result);
        const data = (result && result.body && result.body.data) || {};
        return res.status(200).json({
            ok: !!ok,
            unread: (data.unread != null ? Number(data.unread) : null),
            msg: (result && result.body && result.body.msg) || (ok ? '' : 'Could not mark read.'),
        });
    } catch (_) {
        return res.status(200).json({ ok: false, unread: null, msg: 'Could not reach the API server.' });
    }
});

/* ── NOTIFICATIONS · Mark ALL bell items read (POST /notifications/read-all) ──
 * Forwards to the api POST /sync/notifications/read-all, marking every currently-
 * unread item read for THIS user. Returns JSON { ok, unread } — unread is 0 on
 * success (body.data.unread). The bell's "Mark all read" button POSTs here. */
router.post('/notifications/read-all', async (req, res) => {
    try {
        const result = await api.post(req, '/sync/notifications/read-all', {});
        const ok = apiOk(result);
        const data = (result && result.body && result.body.data) || {};
        return res.status(200).json({
            ok: !!ok,
            unread: (data.unread != null ? Number(data.unread) : 0),
            msg: (result && result.body && result.body.msg) || (ok ? '' : 'Could not mark all read.'),
        });
    } catch (_) {
        return res.status(200).json({ ok: false, unread: null, msg: 'Could not reach the API server.' });
    }
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

/* ── REPORTS · server-rendered PDF proxy (data-only) ──────────
 * GET /reports/pdf/<slug> → streams the api's /reports/<type>/pdf with the SAME
 * auth + company + query, so the browser opens a CLEAN PDF (no sidebar / header
 * / buttons). The two Outstanding slugs map onto the api's single 'outstanding'
 * report (with ?type=). 3-segment path → never shadows the report pages above. */
router.get('/reports/pdf/:slug', async (req, res, next) => {
    try {
        const slug = String(req.params.slug || '');
        const map = {
            'outstanding-receivables': { type: 'outstanding', extra: { type: 'receivable' } },
            'outstanding-payables':    { type: 'outstanding', extra: { type: 'payable' } },
        };
        const m = map[slug] || { type: slug, extra: {} };
        const qs = new URLSearchParams({ ...req.query, ...m.extra }).toString();
        const r = await api.fetchBinary(req, `/reports/${encodeURIComponent(m.type)}/pdf${qs ? '?' + qs : ''}`);
        if (!r || r.status === 0 || !r.buffer || !String(r.contentType).includes('application/pdf')) {
            return next(new Error('Could not generate the report PDF. Please try again.'));
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${slug || 'report'}.pdf"`);
        return res.send(r.buffer);
    } catch (err) { next(err); }
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
                { label: isRec ? 'Customers' : 'Suppliers', value: String(sm.count || 0), icon: 'fa-user-group', tone: 'blue' },
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

/* ── SETTINGS · Accountant Access (CA sharing) ──────────────────
 * Mirrors the app: invite a CA → curated read-only Accountant login; list +
 * revoke. Backed by the api's /account/accountants endpoints. */
router.get('/accountant-access', async (req, res, next) => {
    try {
        const [r, roleOptions] = await Promise.all([
            api.get(req, '/account/accountants'),
            fetchOptions(req, '/roles'),
        ]);
        const rows = (r.body && r.body.data && r.body.data.data) || [];
        res.render('accountant-access/index', {
            title: 'Accountant Access', activeMenu: 'users',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Accountant Access' }],
            roleOptions,
            accountants: rows.map((a) => ({
                id: a.id, name: a.name || '', email: a.email || '', role: a.role || '',
                status: a.status || '', last_login: fmtDate(a.last_login_at),
            })),
        });
    } catch (err) { next(err); }
});
router.post('/accountant-access', async (req, res, next) => {
    try {
        const b = req.body || {};
        const result = await api.post(req, '/account/accountants', {
            name: b.name, email: b.email, password: b.password,
            role_id: b.role_id || undefined,
        });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Accountant invited.');
        else setFlash(req, 'error', apiError(result, 'Could not invite the accountant.'));
        return req.session.save(() => res.redirect('/accountant-access'));
    } catch (err) { next(err); }
});
router.post('/accountant-access/:id/revoke', async (req, res, next) => {
    try {
        const result = await api.del(req, '/account/accountants/' + Number(req.params.id));
        if (apiOk(result)) setFlash(req, 'success', 'Accountant access revoked.');
        else setFlash(req, 'error', apiError(result, 'Could not revoke access.'));
        return req.session.save(() => res.redirect('/accountant-access'));
    } catch (err) { next(err); }
});

/* ── Payment Reminders — overdue customers + manual send ───────── */
router.get('/reminders', async (req, res, next) => {
    try {
        const r = await api.get(req, '/account/reminders');
        const d = (r.body && r.body.data) || {};
        res.render('reminders/index', {
            title: 'Payment Reminders', activeMenu: 'reminders',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Payment Reminders' }],
            reminders: Array.isArray(d.data) ? d.data : [],
            channels: d.channels || { email: false, whatsapp: false },
            totalOutstanding: d.total_outstanding || 0,
        });
    } catch (err) { next(err); }
});
/* ── Set Reminder (per-party schedule) ───────────────────────────
 * GET returns the schedule + a live message preview for one party; POST
 * saves it. Channels are Email / WhatsApp only — the product has no SMS
 * gateway, so there is no credits notion to show. */
router.get('/reminders/:id/schedule', async (req, res, next) => {
    try {
        const r = await api.get(req, `/account/reminders/${Number(req.params.id)}/schedule`);
        const d = (r.body && r.body.data) || {};
        if (!d.customer) {
            setFlash(req, 'error', 'That customer was not found.');
            return res.redirect('/reminders');
        }
        res.render('reminders/schedule', {
            title: `Set Reminder · ${d.customer.name}`,
            activeMenu: 'reminders',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Payment Reminders', href: '/reminders' },
                { label: d.customer.name },
            ],
            customer: d.customer,
            schedule: d.schedule,
            options: d.options || { frequencies: [], channels: [] },
            allowed: d.allowed || { email: false, whatsapp: false },
            outstanding: d.outstanding || 0,
            preview: d.preview || '',
        });
    } catch (err) { next(err); }
});

router.post('/reminders/:id/schedule', async (req, res, next) => {
    try {
        const b = req.body || {};
        const payload = {
            // An unchecked checkbox posts nothing at all, so absence = off.
            enabled:      b.enabled === 'on' || b.enabled === 'true',
            channel:      b.channel,
            frequency:    b.frequency,
            send_hour:    b.send_hour,
            weekday:      b.weekday,
            day_of_month: b.day_of_month,
        };
        const result = await api.put(req, `/account/reminders/${Number(req.params.id)}/schedule`, payload);
        if (apiOk(result)) setFlash(req, 'success', 'Reminder schedule saved.');
        else setFlash(req, 'error', apiError(result, 'Could not save the schedule.'));
        return req.session.save(() => res.redirect(`/reminders/${Number(req.params.id)}/schedule`));
    } catch (err) { next(err); }
});

router.post('/reminders/:id/send', async (req, res, next) => {
    try {
        const channel = (req.body && req.body.channel) || 'email';
        const result = await api.post(req, `/account/reminders/${Number(req.params.id)}/send`, { channel });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Reminder sent.');
        else setFlash(req, 'error', apiError(result, 'Could not send the reminder.'));
        return req.session.save(() => res.redirect('/reminders'));
    } catch (err) { next(err); }
});

/* ── Business Analytics — read-only insights dashboard ────────── */
router.get('/analytics', async (req, res, next) => {
    try {
        const r = await api.get(req, '/account/analytics');
        const analytics = (r.body && r.body.data) || {};
        res.render('analytics/index', {
            title: 'Business Analytics', activeMenu: 'analytics',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Business Analytics' }],
            analytics,
        });
    } catch (err) { next(err); }
});

/* ── Expenses — list + add/edit/delete + categories ───────────── */
function _expenseBody(b) {
    return {
        category_id:  b.category_id || undefined,
        vendor:       b.vendor,
        expense_date: b.expense_date || undefined,
        amount:       b.amount,
        payment_mode: b.payment_mode || undefined,
        reference:    b.reference,
        notes:        b.notes,
    };
}
router.get('/expenses', async (req, res, next) => {
    try {
        const [er, categories] = await Promise.all([
            api.get(req, '/expenses?per_page=100'),
            fetchOptions(req, '/expense-categories'),
        ]);
        const rows = (er.body && er.body.data && er.body.data.data) || [];
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        let total = 0, monthTotal = 0;
        rows.forEach((e) => {
            const amt = Number(e.amount) || 0;
            total += amt;
            const d = e.expense_date ? String(e.expense_date).slice(0, 10) : '';
            if (d && d >= monthStart) monthTotal += amt;
        });
        res.render('expenses/index', {
            title: 'Expenses', activeMenu: 'expenses',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Expenses' }],
            expenses: rows, categories,
            total: Math.round(total * 100) / 100, monthTotal: Math.round(monthTotal * 100) / 100,
        });
    } catch (err) { next(err); }
});
router.post('/expenses', async (req, res, next) => {
    try {
        const result = await api.post(req, '/expenses', _expenseBody(req.body || {}));
        if (apiOk(result)) setFlash(req, 'success', 'Expense added.');
        else setFlash(req, 'error', apiError(result, 'Could not add the expense.'));
        return req.session.save(() => res.redirect('/expenses'));
    } catch (err) { next(err); }
});
router.post('/expenses/:id/delete', async (req, res, next) => {
    try {
        const result = await api.del(req, `/expenses/${Number(req.params.id)}`);
        if (apiOk(result)) setFlash(req, 'success', 'Expense deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the expense.'));
        return req.session.save(() => res.redirect('/expenses'));
    } catch (err) { next(err); }
});
router.post('/expenses/:id', async (req, res, next) => {
    try {
        const result = await api.put(req, `/expenses/${Number(req.params.id)}`, _expenseBody(req.body || {}));
        if (apiOk(result)) setFlash(req, 'success', 'Expense updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update the expense.'));
        return req.session.save(() => res.redirect('/expenses'));
    } catch (err) { next(err); }
});
router.post('/expense-categories', async (req, res, next) => {
    try {
        const result = await api.post(req, '/expense-categories', { name: (req.body && req.body.name) || '' });
        if (apiOk(result)) setFlash(req, 'success', 'Category added.');
        else setFlash(req, 'error', apiError(result, 'Could not add the category.'));
        return req.session.save(() => res.redirect('/expenses'));
    } catch (err) { next(err); }
});
router.post('/expense-categories/:id/delete', async (req, res, next) => {
    try {
        const result = await api.del(req, `/expense-categories/${Number(req.params.id)}`);
        if (apiOk(result)) setFlash(req, 'success', 'Category deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the category.'));
        return req.session.save(() => res.redirect('/expenses'));
    } catch (err) { next(err); }
});

/* ── Recurring Invoices — list + add/edit/delete + generate-now ── */
function _recurringBody(b) {
    return {
        customer_id:   b.customer_id || undefined,
        title:         b.title,
        description:   b.description,
        amount:        b.amount,
        gst_rate:      b.gst_rate || undefined,
        frequency:     b.frequency || undefined,
        due_days:      b.due_days || undefined,
        start_date:    b.start_date || undefined,
        next_run_date: b.next_run_date || undefined,
        end_date:      b.end_date || undefined,
        status:        b.status || undefined,
    };
}
router.get('/recurring-invoices', async (req, res, next) => {
    try {
        const [rr, customers] = await Promise.all([
            api.get(req, '/recurring-invoices?per_page=100'),
            fetchOptions(req, '/customers'),
        ]);
        const rows = (rr.body && rr.body.data && rr.body.data.data) || [];
        res.render('recurring-invoices/index', {
            title: 'Recurring Invoices', activeMenu: 'recurring',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Recurring Invoices' }],
            templates: rows, customers,
        });
    } catch (err) { next(err); }
});
router.post('/recurring-invoices', async (req, res, next) => {
    try {
        const result = await api.post(req, '/recurring-invoices', _recurringBody(req.body || {}));
        if (apiOk(result)) setFlash(req, 'success', 'Recurring invoice created.');
        else setFlash(req, 'error', apiError(result, 'Could not create it.'));
        return req.session.save(() => res.redirect('/recurring-invoices'));
    } catch (err) { next(err); }
});
router.post('/recurring-invoices/:id/generate', async (req, res, next) => {
    try {
        const result = await api.post(req, `/recurring-invoices/${Number(req.params.id)}/generate`, {});
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Invoice generated.');
        else setFlash(req, 'error', apiError(result, 'Could not generate the invoice.'));
        return req.session.save(() => res.redirect('/recurring-invoices'));
    } catch (err) { next(err); }
});
router.post('/recurring-invoices/:id/delete', async (req, res, next) => {
    try {
        const result = await api.del(req, `/recurring-invoices/${Number(req.params.id)}`);
        if (apiOk(result)) setFlash(req, 'success', 'Recurring invoice deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete it.'));
        return req.session.save(() => res.redirect('/recurring-invoices'));
    } catch (err) { next(err); }
});
/* View a template + the invoices it has generated (how many came out / are due). */
router.get('/recurring-invoices/:id/view', async (req, res, next) => {
    try {
        const { body } = await api.get(req, `/recurring-invoices/${Number(req.params.id)}/invoices`);
        const payload  = (body && body.data) || {};
        if (!payload.template) {
            setFlash(req, 'error', 'Recurring template not found.');
            return req.session.save(() => res.redirect('/recurring-invoices'));
        }
        res.render('recurring-invoices/view', {
            title: 'Recurring · ' + (payload.template.title || 'Template'),
            activeMenu: 'recurring',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Recurring Invoices', href: '/recurring-invoices' },
                { label: payload.template.title || 'Template' },
            ],
            template: payload.template,
            invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
        });
    } catch (err) { next(err); }
});
router.post('/recurring-invoices/:id', async (req, res, next) => {
    try {
        const result = await api.put(req, `/recurring-invoices/${Number(req.params.id)}`, _recurringBody(req.body || {}));
        if (apiOk(result)) setFlash(req, 'success', 'Recurring invoice updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update it.'));
        return req.session.save(() => res.redirect('/recurring-invoices'));
    } catch (err) { next(err); }
});

/* ── Bank Reconciliation — import (CSV parsed client-side) + match ── */
router.get('/bank-reconciliation', async (req, res, next) => {
    try {
        const r = await api.get(req, '/bank/transactions');
        const d = (r.body && r.body.data) || {};
        res.render('bank-reconciliation/index', {
            title: 'Bank Reconciliation', activeMenu: 'bank',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Bank Reconciliation' }],
            transactions: Array.isArray(d.data) ? d.data : [], summary: d.summary || {},
        });
    } catch (err) { next(err); }
});
router.post('/bank-reconciliation/import', async (req, res, next) => {
    try {
        let rows = [];
        try { rows = JSON.parse((req.body && req.body.rows) || '[]'); } catch (_) { rows = []; }
        const result = await api.post(req, '/bank/import', { rows });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Statement imported.');
        else setFlash(req, 'error', apiError(result, 'Could not import the statement.'));
        return req.session.save(() => res.redirect('/bank-reconciliation'));
    } catch (err) { next(err); }
});
router.get('/bank-reconciliation/:id/candidates', async (req, res) => {
    try {
        const r = await api.get(req, `/bank/transactions/${Number(req.params.id)}/candidates`);
        const d = (r.body && r.body.data) || {};
        res.json({ data: Array.isArray(d.data) ? d.data : [] });
    } catch (_) { res.json({ data: [] }); }
});
function _bankAction(apiPath, okMsg, errMsg) {
    return async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const result = apiPath === 'delete'
                ? await api.del(req, `/bank/transactions/${id}`)
                : await api.post(req, `/bank/transactions/${id}/${apiPath}`, req.body || {});
            if (apiOk(result)) setFlash(req, 'success', okMsg);
            else setFlash(req, 'error', apiError(result, errMsg));
            return req.session.save(() => res.redirect('/bank-reconciliation'));
        } catch (err) { next(err); }
    };
}
router.post('/bank-reconciliation/:id/match',   _bankAction('match',   'Matched.',       'Could not match.'));
router.post('/bank-reconciliation/:id/unmatch', _bankAction('unmatch', 'Unmatched.',     'Could not unmatch.'));
router.post('/bank-reconciliation/:id/ignore',  _bankAction('ignore',  'Ignored.',       'Could not ignore.'));
router.post('/bank-reconciliation/:id/delete',  _bankAction('delete',  'Line deleted.',  'Could not delete.'));

/* ── e-Invoice & e-Way Bill ── */
router.get('/einvoices', async (req, res, next) => {
    try {
        const qs = new URLSearchParams();
        if (req.query.page) qs.set('page', req.query.page);
        if (req.query.per_page) qs.set('per_page', req.query.per_page);
        if (req.query.search) qs.set('search', req.query.search);
        if (req.query.status) qs.set('status', req.query.status);
        if (req.query.date_from) qs.set('date_from', req.query.date_from);
        if (req.query.date_to) qs.set('date_to', req.query.date_to);
        const r = await api.get(req, '/einvoices' + (qs.toString() ? `?${qs}` : ''));
        const d = (r.body && r.body.data) || {};
        const meta = d.meta || {};
        res.render('einvoices/index', {
            title: 'e-Invoice & e-Way Bill', activeMenu: 'einvoice',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'e-Invoice' }],
            rows: Array.isArray(d.data) ? d.data : [], gspConfigured: !!d.gsp_configured,
            total: meta.total || 0, page: meta.page || 1, perPage: meta.per_page || 20,
            search: req.query.search || '',
            statusFilter: req.query.status || '', dateFrom: req.query.date_from || '', dateTo: req.query.date_to || '',
        });
    } catch (err) { next(err); }
});
router.get('/einvoices/dashboard', async (req, res, next) => {
  try {
    const { body } = await api.get(req, '/einvoices/dashboard');
    const d = (body && body.data) || {};
    res.render('einvoices/dashboard', {
        title: 'e-Invoice Dashboard', activeMenu: 'einvoice-dash',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'e-Invoice Dashboard' }],
        d,
    });
  } catch (err) { next(err); }
});
router.get('/einvoices/reports', async (req, res, next) => {
  try {
    const type = String(req.query.type || 'irn');
    const qs = new URLSearchParams({ type });
    if (req.query.from) qs.set('from', req.query.from);
    if (req.query.to) qs.set('to', req.query.to);
    const { body } = await api.get(req, '/einvoices/report?' + qs.toString());
    const d = (body && body.data) || {};
    res.render('einvoices/reports', {
        title: 'e-Invoice Reports', activeMenu: 'einvoice-rep',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'e-Invoice Reports' }],
        type, rows: Array.isArray(d.data) ? d.data : [],
        from: req.query.from || '', to: req.query.to || '',
    });
  } catch (err) { next(err); }
});
router.get('/einvoices/:id/view', async (req, res, next) => {
  try {
    const { body } = await api.get(req, `/einvoices/${Number(req.params.id)}/details`);
    const dd = (body && body.data) || {};
    res.render('einvoices/details', {
        title: 'e-Invoice Details', activeMenu: 'einvoice',
        breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'e-Invoice', href: '/einvoices' }, { label: 'Details' }],
        ei: dd.einvoice || {}, invoice: dd.invoice || {}, customer: dd.customer || null,
        items: dd.items || [], apiLogs: dd.api_logs || [], transport: dd.transport || [],
        cancellations: dd.cancellations || [], validity: dd.validity || [],
    });
  } catch (err) { next(err); }
});
router.post('/einvoices/bulk-generate', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
    const result = await api.post(req, '/einvoices/bulk-generate', { ids });
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.msg) || 'Bulk generate complete.') : apiError(result, 'Bulk generate failed.'));
    return req.session.save(() => res.redirect('/einvoices'));
  } catch (err) { next(err); }
});
/* Delivery — Download (official-format PDF) / Email / WhatsApp (no browser print).
 * The API renders the e-Invoice/e-Way Bill PDF; we stream those bytes straight
 * to the browser (same document the app + email + WhatsApp get). */
router.get('/einvoices/:id/download', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await api.fetchBinary(req, `/einvoices/${id}/download`);
    if (r.status !== 200 || !r.buffer) {
        setFlash(req, 'error', 'Could not generate the PDF. Make sure the e-Invoice exists.');
        return req.session.save(() => res.redirect('/einvoices'));
    }
    res.setHeader('Content-Type', r.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="einvoice-${id}.pdf"`);
    return res.end(r.buffer);
  } catch (err) { next(err); }
});
router.post('/einvoices/:id/email', async (req, res, next) => {
  try {
    const result = await api.post(req, `/einvoices/${Number(req.params.id)}/email`, req.body || {});
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.msg) || 'e-Invoice emailed.') : apiError(result, 'Could not email the e-Invoice.'));
    return req.session.save(() => res.redirect('/einvoices'));
  } catch (err) { next(err); }
});
router.post('/einvoices/:id/whatsapp', async (req, res, next) => {
  try {
    const result = await api.post(req, `/einvoices/${Number(req.params.id)}/whatsapp`, req.body || {});
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.msg) || 'Sent on WhatsApp.') : apiError(result, 'Could not send on WhatsApp.'));
    return req.session.save(() => res.redirect('/einvoices'));
  } catch (err) { next(err); }
});
router.get('/einvoices/:id/payload', async (req, res) => {
    try {
        const r = await api.get(req, `/einvoices/${Number(req.params.id)}`);
        const e = (r.body && r.body.data) || null;
        res.json({ payload: e && e.payload ? e.payload : null });
    } catch (_) { res.json({ payload: null }); }
});
router.post('/einvoices/:id/generate', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/generate`, {});
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'IRP payload prepared.');
        else setFlash(req, 'error', apiError(result, 'Could not generate.'));
        return req.session.save(() => res.redirect('/einvoices'));
    } catch (err) { next(err); }
});
router.post('/einvoices/:id/manual', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/manual`, req.body || {});
        if (apiOk(result)) setFlash(req, 'success', 'e-Invoice / e-Way details saved.');
        else setFlash(req, 'error', apiError(result, 'Could not save.'));
        return req.session.save(() => res.redirect('/einvoices'));
    } catch (err) { next(err); }
});
router.post('/einvoices/:id/cancel', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/cancel`, req.body || {});
        if (apiOk(result)) setFlash(req, 'success', 'e-Invoice cancelled.');
        else setFlash(req, 'error', apiError(result, 'Could not cancel.'));
        return req.session.save(() => res.redirect('/einvoices'));
    } catch (err) { next(err); }
});
router.post('/einvoices/:id/eway', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/eway`, req.body || {});
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'e-Way Bill generated.');
        else setFlash(req, 'error', apiError(result, 'Could not generate e-Way.'));
        return req.session.save(() => res.redirect('/einvoices'));
    } catch (err) { next(err); }
});
router.post('/einvoices/:id/update-vehicle', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/update-vehicle`, req.body || {});
        if (apiOk(result)) setFlash(req, 'success', 'Vehicle updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update the vehicle.'));
        return req.session.save(() => res.redirect('/einvoices'));
    } catch (err) { next(err); }
});
router.post('/einvoices/:id/extend', async (req, res, next) => {
    try {
        const result = await api.post(req, `/einvoices/${Number(req.params.id)}/extend`, req.body || {});
        if (apiOk(result)) setFlash(req, 'success', 'e-Way validity extended.');
        else setFlash(req, 'error', apiError(result, 'Could not extend validity.'));
        return req.session.save(() => res.redirect('/einvoices'));
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

/* Turn a permissions array (['mod.action', …]) into a quick-lookup set for the
 * matrix's pre-check. */
function permsToSet(list) {
    const out = {};
    (Array.isArray(list) ? list : []).forEach((s) => { if (s) out[String(s)] = true; });
    return out;
}

/* ── SETTINGS · Roles & Permissions — UNIFIED page (GET /roles) ─────
 * ONE screen, backed by the REAL /account/roles API, for BOTH the
 * super-admin and the company-admin (requireRoleManager). It merges the
 * old /roles (matrix) and /roles-admin (CRUD) pages:
 *   • lists every VISIBLE role (system + this license's custom) as chips,
 *   • shows the selected role's permission matrix (modules × entitled
 *     actions), pre-checked from its granted slugs,
 *   • supports Add / Rename / Delete of custom roles and Save of the
 *     selected role's permissions.
 *
 * The matrix is built from the license's ENTITLEMENTS (available-permissions)
 * so only entitled modules/actions appear. EVERY visible role's granted
 * permission set is preloaded into a JSON island so /js/rbac.js can swap the
 * matrix instantly when a chip is clicked (no round-trip); the selected role
 * is also server-rendered so the page works without JS and ?role= deep-links.
 *
 * Selected role = ?role=<id> when valid, else the first EDITABLE custom role,
 * else the first role. */
router.get('/roles', requireRoleManager, async (req, res, next) => {
    try {
        const isSuper = req.session && req.session.user && req.session.user.role_slug === 'super-admin';

        // 1) Role list (+ counts + editability) from the real management list.
        const listRes  = await api.get(req, '/account/roles');
        const listBody = (listRes.body && listRes.body.data) || {};
        const rawRoles = Array.isArray(listBody) ? listBody
            : (Array.isArray(listBody.data) ? listBody.data : []);
        const roles = rawRoles.map((r) => ({
            id:         r.id,
            name:       r.name || '',
            slug:       r.slug || '',
            is_system:  !!r.is_system,
            license_id: r.license_id != null ? r.license_id : null,
            editable:   !!r.editable,
            user_count: r.user_count != null ? Number(r.user_count) : 0,
        }));

        // 2) Resolve the selected role: ?role=<id> if visible, else first
        //    editable custom role, else first role.
        const wantId   = Number(req.query.role);
        let selected   = roles.find((r) => r.id === wantId)
            || roles.find((r) => r.editable && !r.is_system)
            || roles[0]
            || null;

        // 3) Entitlement-scoped module/action catalogue for the matrix. For a
        //    super-admin scope it to the SELECTED role's own license (a global
        //    template → full catalogue); a license-admin always gets their own.
        const licId     = (isSuper && selected && selected.license_id) ? Number(selected.license_id) : null;
        const permsPath = '/account/roles/available-permissions' + (licId ? `?license_id=${licId}` : '');
        const apRes     = await api.get(req, permsPath);
        const apData    = (apRes.body && apRes.body.data) || {};
        const modules   = Array.isArray(apData.modules) ? apData.modules : [];

        // 4) Granted permission set for EVERY visible role → JSON island for
        //    instant client-side chip switching. Each value is a set keyed by
        //    `<module>.<action>` slug. Fetched in parallel.
        const detailResults = await Promise.all(
            roles.map((r) => api.get(req, `/account/roles/${r.id}`)),
        );
        const permsByRole = {};   // { roleId: { 'module.action': true } }
        roles.forEach((r, i) => {
            const d = (detailResults[i] && detailResults[i].body && detailResults[i].body.data) || {};
            permsByRole[r.id] = permsToSet(d.permissions);
        });

        const selectedPerms = selected ? (permsByRole[selected.id] || {}) : {};

        res.render('roles/index', {
            title: 'Roles & Permissions',
            activeMenu: 'roles',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Roles & Permissions' }],
            roles,
            modules,
            selected,
            selectedPerms,
            permsByRole,
            pageScript: '<script src="/js/rbac.js" defer></script>',
        });
    } catch (err) { next(err); }
});

/* ── POST /roles — create a custom role (name only; permissions are set
 * afterwards from the matrix). Mirrors the old /roles-admin create. */
router.post('/roles', requireRoleManager, async (req, res, next) => {
    try {
        const isSuper = req.session && req.session.user && req.session.user.role_slug === 'super-admin';
        const payload = { name: req.body.name };
        // Super-admin: scope the new role to the selected license (header
        // switcher); with none selected the api makes a global TEMPLATE role.
        if (isSuper && req.session.licenseId) payload.license_id = Number(req.session.licenseId);
        const result = await api.post(req, '/account/roles', payload);
        if (apiOk(result)) {
            setFlash(req, 'success', (result.body && result.body.msg) || 'Role created successfully.');
            // Jump straight to the new role so the admin can set its permissions.
            const newId = result.body && result.body.data && result.body.data.id;
            const dest  = newId ? `/roles?role=${newId}` : '/roles';
            return req.session.save(() => res.redirect(dest));
        }
        setFlash(req, 'error', apiError(result, 'Could not create the role.'));
        return req.session.save(() => res.redirect('/roles'));
    } catch (err) { next(err); }
});

/* ── POST /roles/:id — rename a custom role, then (if slugs supplied) set its
 * permissions. The matrix Save posts `slugs` (JSON); the Rename modal posts
 * `name` only. Mirrors the old /roles-admin/:id handler. Browsers can't PUT
 * from a form, so we proxy to api.put for both calls. */
router.post('/roles/:id', requireRoleManager, async (req, res, next) => {
    try {
        const id   = Number(req.params.id);
        const back = `/roles?role=${id}`;
        const hasName  = req.body.name !== undefined && req.body.name !== null && req.body.name !== '';
        const hasSlugs = req.body.slugs !== undefined;

        // Rename (when a name is supplied).
        if (hasName) {
            const renameRes = await api.put(req, `/account/roles/${id}`, { name: req.body.name });
            if (!apiOk(renameRes)) {
                setFlash(req, 'error', apiError(renameRes, 'Could not rename the role.'));
                return req.session.save(() => res.redirect(back));
            }
            if (!hasSlugs) {
                setFlash(req, 'success', (renameRes.body && renameRes.body.msg) || 'Role renamed.');
                return req.session.save(() => res.redirect(back));
            }
        }

        // Set permissions (when the matrix Save supplied a slug list).
        if (hasSlugs) {
            let slugs = [];
            try { slugs = JSON.parse(req.body.slugs || '[]'); } catch (_) { slugs = []; }
            if (!Array.isArray(slugs)) slugs = [];
            const permsRes = await api.put(req, `/account/roles/${id}/permissions`, { slugs });
            if (apiOk(permsRes)) setFlash(req, 'success', (permsRes.body && permsRes.body.msg) || 'Permissions updated.');
            else setFlash(req, 'error', apiError(permsRes, 'Could not update permissions.'));
            return req.session.save(() => res.redirect(back));
        }

        setFlash(req, 'error', 'Nothing to save.');
        return req.session.save(() => res.redirect(back));
    } catch (err) { next(err); }
});

/* ── POST /roles/:id/permissions — save a role's permission set (matrix Save).
 * The matrix (rbac.js) posts the checked `<module>.<action>` slugs as JSON to
 * the REAL /account/roles/:id/permissions endpoint. */
router.post('/roles/:id/permissions', requireRoleManager, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        let slugs = [];
        try { slugs = JSON.parse(req.body.slugs || '[]'); } catch (_) { slugs = []; }
        if (!Array.isArray(slugs)) slugs = [];
        const result = await api.put(req, `/account/roles/${id}/permissions`, { slugs });
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Permissions updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update permissions.'));
        return req.session.save(() => res.redirect(`/roles?role=${id}`));
    } catch (err) { next(err); }
});

/* ── POST /roles/:id/delete — delete a custom role (api returns 422 with a
 * message when the role is still assigned to users; surface that message). */
router.post('/roles/:id/delete', requireRoleManager, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.del(req, `/account/roles/${id}`);
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Role deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the role.'));
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
        // License-scoped SYNC flags (auto_update / push_enabled / pull_enabled /
        // sync_enabled) — prefill the Tally Sync tab's Sync Settings switches.
        // Default ON when absent so a pre-migration DB shows all-ON.
        const _syncIn = payload.sync || {};
        const syncFlags = {
            sync_enabled:      _syncIn.sync_enabled !== false,
            sync_push_enabled: _syncIn.push_enabled !== false,
            sync_pull_enabled: _syncIn.pull_enabled !== false,
            auto_update:       _syncIn.auto_update  !== false,
        };
        // Syncable-module catalog + the current per-module selection for the
        // auto-push / auto-pull popups. Default to ALL when the API omits them.
        const syncModules = Array.isArray(payload.modules) ? payload.modules : [];
        const allKeys = syncModules.map((m) => m.key);
        const syncPushModules = Array.isArray(_syncIn.push_modules) ? _syncIn.push_modules : allKeys;
        const syncPullModules = Array.isArray(_syncIn.pull_modules) ? _syncIn.pull_modules : allKeys;
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
            syncFlags,                 // = body.data.sync, normalised for the Sync Settings switches
            syncModules,               // = body.data.modules [{key,label}] — the auto-sync popup catalog
            syncPushModules,           // selected module keys for AUTO push (Cloud→Tally)
            syncPullModules,           // selected module keys for AUTO pull (Tally→Cloud)

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
        // Forward filter dropdown params so the api can actually filter.
        for (const k of ['location', 'sales_person', 'customer_group', 'gst', 'created_from', 'created_to']) {
            if (req.query[k]) qs.set(k, String(req.query[k]));
        }

        const { body } = await api.get(req, `/customers?${qs.toString()}`);
        const payload  = (body && body.data) || {};
        const rows     = Array.isArray(payload.data) ? payload.data : [];
        const meta     = payload.meta || { total: rows.length, page, per_page: perPage };
        const config   = await fetchConfig(req, ['customer_groups']);
        // Real org data for the filter dropdowns (was mock).
        const [locOpts, spOpts] = await Promise.all([
            fetchOptions(req, '/locations'),
            fetchOptions(req, '/sales-persons'),
        ]);

        // Map api columns → the view's expected keys.
        const customers = rows.map((r) => ({
            id:              r.id,
            name:            r.name,
            location:        r.location || '',
            state:           r.state || '',
            mobile:          r.mobile || '',
            gst:             r.gst_number || '',
            opening_balance: r.opening_balance,
            credit_limit:    r.credit_limit,
            sales_person:    r.sales_person || '',
            status:          r.status,
            created_at:      fmtDate(r.created_at),
            // Full tab-wise detail for the View popup (every field, grouped).
            _detail: [
                { group: 'Basic Information' },
                { label: 'Customer Name', value: r.name || '—' },
                { label: 'Mobile', value: r.mobile || '—' },
                { label: 'Alternate Mobile', value: r.alternate_mobile || '—' },
                { label: 'Email', value: r.email || '—' },
                { label: 'Status', value: r.status || '—' },
                { group: 'Tax & Statutory' },
                { label: 'GST Number', value: r.gst_number || '—' },
                { label: 'PAN Number', value: r.pan_number || '—' },
                { label: 'GST Registration Type', value: r.gst_registration_type || '—' },
                { group: 'Address' },
                { label: 'Billing Address', value: r.billing_address || '—' },
                { label: 'Shipping Address', value: r.shipping_address || '—' },
                { label: 'Country', value: r.country || '—' },
                { label: 'State', value: r.state || '—' },
                { label: 'Pincode', value: r.pincode || '—' },
                { group: 'Financial' },
                { label: 'Opening Balance', value: (r.opening_balance != null ? (String(r.opening_balance) + ' ' + (r.opening_balance_type || 'Cr')) : '—') },
                { label: 'Credit Limit', value: (r.credit_limit != null ? String(r.credit_limit) : '—') },
                { group: 'Assignment' },
                { label: 'Location', value: r.location || '—' },
                { label: 'Sales Person', value: r.sales_person || '—' },
                { label: 'Customer Group', value: r.customer_group || '—' },
                { label: 'Ledger Group', value: r.ledger_group || '—' },
                { group: 'Notes' },
                { label: 'Notes', value: r.notes || '—' },
                { label: 'Internal Remarks', value: r.internal_remarks || '—' },
            ],
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

            // Filter dropdown option sources — REAL org data.
            locations:      locOpts.map((o) => o.name),
            salesPersons:   spOpts.map((o) => o.name),
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
        const [locationOptions, salesPersonOptions, customerGroupOptions, ledgerGroupOptions] = await Promise.all([
            fetchOptions(req, '/locations'),
            fetchOptions(req, '/sales-persons'),
            fetchOptions(req, '/customer-groups'),
            fetchLedgerGroupOptions(req),
        ]);
        res.render('customers/form', {
            title: 'Add Customer',
            activeMenu: 'customers',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Customers', href: '/customers' },
                { label: 'Add Customer' },
            ],
            locationOptions, salesPersonOptions, customerGroupOptions, ledgerGroupOptions,
            gstStates: GST_STATES, gstRegistrationTypes: GST_REGISTRATION_TYPES,
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
            gst_number:        b.gst_number || undefined,
            pan_number:        b.pan_number || undefined,
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
            custom_fields:     assembleCustomFields(b),
            ledger_group:          b.ledger_group || undefined,
            opening_balance_type:  b.opening_balance_type || undefined,
            country:               b.country || undefined,
            state:                 b.state || undefined,
            pincode:               b.pincode || undefined,
            gst_registration_type: b.gst_registration_type || undefined,
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
        const [record, locationOptions, salesPersonOptions, customerGroupOptions, ledgerGroupOptions] = await Promise.all([
            fetchRecord(req, '/customers', id),
            fetchOptions(req, '/locations'),
            fetchOptions(req, '/sales-persons'),
            fetchOptions(req, '/customer-groups'),
            fetchLedgerGroupOptions(req),
        ]);
        if (!record) { setFlash(req, 'error', 'Customer not found.'); return req.session.save(() => res.redirect('/customers')); }
        res.render('customers/form', {
            title: 'Edit Customer', activeMenu: 'customers',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Customers', href: '/customers' }, { label: 'Edit Customer' }],
            record, locationOptions, salesPersonOptions, customerGroupOptions, ledgerGroupOptions,
            gstStates: GST_STATES, gstRegistrationTypes: GST_REGISTRATION_TYPES,
        });
    } catch (err) { next(err); }
});
router.post('/customers/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const b = req.body;
        const payload = {
            name: b.name, mobile: b.mobile || undefined, alternate_mobile: b.alternate_mobile || undefined,
            email: b.email || undefined, gst_number: b.gst_number || undefined, pan_number: b.pan_number || undefined,
            location_id: _num(b.location_id), sales_person_id: _num(b.sales_person_id),
            customer_group_id: _num(b.customer_group_id), opening_balance: _num(b.opening_balance),
            credit_limit: _num(b.credit_limit), status: b.status || 'Active',
            billing_address: b.billing_address || undefined, shipping_address: b.shipping_address || undefined,
            is_tally_ledger: asBool(b.is_tally_ledger), notes: b.notes || undefined, internal_remarks: b.internal_remarks || undefined,
            custom_fields: assembleCustomFields(b),
            ledger_group: b.ledger_group || undefined, opening_balance_type: b.opening_balance_type || undefined,
            country: b.country || undefined, state: b.state || undefined, pincode: b.pincode || undefined,
            gst_registration_type: b.gst_registration_type || undefined,
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
            email: b.email || undefined, gst_number: b.gst_number || undefined, pan_number: b.pan_number || undefined,
            supplier_group: b.supplier_group || undefined,
            location_id: _num(b.location_id), opening_balance: _num(b.opening_balance), payment_terms: b.payment_terms || undefined,
            address: b.address || undefined,
            status: b.status || 'Active', is_tally_ledger: asBool(b.is_tally_ledger),
            custom_fields: assembleCustomFields(b),
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
            custom_fields: assembleCustomFields(b),
        };
        const result = await api.put(req, `/products/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Product updated successfully.'); return req.session.save(() => res.redirect('/products')); }
        setFlash(req, 'error', apiError(result, 'Could not update product.'));
        return req.session.save(() => res.redirect(`/products/${id}/edit`));
    } catch (err) { next(err); }
});

/* ── Product images · upload gallery (multipart → api) ────────────
 * Receive up to 8 images in WEB (multer, in-memory), then FORWARD them to the
 * api POST /products/:id/images as multipart (form-data + the session bearer +
 * X-Company-Id). Images are NOT synced to Tally — they live only in our cloud. */
router.post('/products/:id/images', (req, res) => {
    const id   = Number(req.params.id);
    const back = `/products/${id}/edit`;
    productImgUpload(req, res, async (mErr) => {
        if (mErr) {
            const msg = mErr.code === 'LIMIT_FILE_SIZE'  ? 'Each image must be 5MB or smaller.'
                      : mErr.code === 'LIMIT_FILE_COUNT' ? 'You can upload at most 8 images at once.'
                      : 'Could not read the uploaded images.';
            setFlash(req, 'error', msg);
            return req.session.save(() => res.redirect(back));
        }
        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) {
            setFlash(req, 'error', 'Please choose at least one image (JPG, PNG, WEBP or GIF).');
            return req.session.save(() => res.redirect(back));
        }
        try {
            const form = new FormData();
            for (const f of files) {
                form.append('images', f.buffer, {
                    filename:    f.originalname || 'image',
                    contentType: f.mimetype || 'application/octet-stream',
                    knownLength: f.buffer.length,
                });
            }
            const headers = Object.assign({ Accept: 'application/json' }, form.getHeaders());
            if (req.session && req.session.token)            headers.Authorization  = `Bearer ${req.session.token}`;
            if (req.session && req.session.companyId != null) headers['X-Company-Id'] = String(req.session.companyId);
            let parsed = null;
            try {
                const resp = await fetch(`${api.API_URL}/products/${id}/images`, { method: 'POST', headers, body: form.getBuffer() });
                try { parsed = await resp.json(); } catch { parsed = null; }
            } catch (e) {
                setFlash(req, 'error', 'Cannot reach the API server.');
                return req.session.save(() => res.redirect(back));
            }
            if (parsed && parsed.status === 200) setFlash(req, 'success', parsed.msg || 'Images uploaded.');
            else                                 setFlash(req, 'error', (parsed && parsed.msg) || 'Could not upload images.');
            return req.session.save(() => res.redirect(back));
        } catch (e) {
            setFlash(req, 'error', 'Could not upload images.');
            return req.session.save(() => res.redirect(back));
        }
    });
});

/* ── Product images · delete one (POST — HTML forms can't DELETE) ── */
router.post('/products/:id/images/:imageId/delete', async (req, res, next) => {
    try {
        const id = Number(req.params.id); const imageId = Number(req.params.imageId);
        const result = await api.del(req, `/products/${id}/images/${imageId}`);
        if (apiOk(result)) setFlash(req, 'success', 'Image removed.');
        else               setFlash(req, 'error', apiError(result, 'Could not remove image.'));
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
            custom_fields: assembleCustomFields(b),
        };
        const result = await api.put(req, `/locations/${id}`, payload);
        if (apiOk(result)) { setFlash(req, 'success', 'Location updated successfully.'); return req.session.save(() => res.redirect('/locations')); }
        setFlash(req, 'error', apiError(result, 'Could not update location.'));
        return req.session.save(() => res.redirect(`/locations/${id}/edit`));
    } catch (err) { next(err); }
});

/* Sales Persons — edit form prefills the base record PLUS the assignments
 * (assigned location ids, the linked login user, and the per-location customer
 * checklists with their saved ticks) from GET /sales-persons/:id/assignments. */
router.get('/sales-persons/:id/edit', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [record, locationOptions, roleOptions, customersByLoc] = await Promise.all([
            fetchRecord(req, '/sales-persons', id),
            fetchLocationCards(req),
            fetchRoleOptions(req),
            fetchCustomersByLocation(req),
        ]);
        if (!record) { setFlash(req, 'error', 'Sales person not found.'); return req.session.save(() => res.redirect('/sales-persons')); }

        // Prefill: assigned location ids, linked login user, saved customer ticks.
        let assignedLocationIds = [];
        let linkedUser = null;
        let assignedCustomers = {};
        try {
            const ar = await api.get(req, `/sales-persons/${id}/assignments`);
            const data = (ar.body && ar.body.data) || {};
            assignedLocationIds = Array.isArray(data.location_ids) ? data.location_ids.map(Number) : [];
            linkedUser = data.user || null;
            assignedCustomers = (data.customers && typeof data.customers === 'object') ? data.customers : {};
        } catch (_) { /* non-fatal — render add-style empty assignments */ }

        res.render('sales-persons/form', {
            title: 'Edit Sales Person', activeMenu: 'sales',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Sales Persons', href: '/sales-persons' }, { label: 'Edit Sales Person' }],
            record, locationOptions, roleOptions,
            assignedLocationIds, linkedUser,
            locationCustomers: customersByLoc,
            assignedCustomers,
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
        if (!apiOk(result)) {
            setFlash(req, 'error', apiError(result, 'Could not update sales person.'));
            return req.session.save(() => res.redirect(`/sales-persons/${id}/edit`));
        }

        // Replace assigned locations FIRST (the customer assignment endpoint
        // requires the location to already be assigned), then the per-location
        // customers, then create/update the login. Collect warnings + the login
        // note (seat-limit / Inactive) so the operator sees them.
        const warnings = [];
        let loginNote = '';

        const locRes = await applySalesPersonLocations(req, id, b);
        if (!locRes.ok) warnings.push(locRes.msg);

        const custRes = await applySalesPersonCustomers(req, id, b);
        if (!custRes.ok && custRes.msg) warnings.push(custRes.msg);

        const loginRes = await applySalesPersonLogin(req, id, b);
        if (loginRes && !loginRes.ok) warnings.push(loginRes.msg);
        else if (loginRes && loginRes.ok && loginRes.msg) loginNote = loginRes.msg;

        if (warnings.length) {
            setFlash(req, 'error', 'Sales person updated, but: ' + warnings.join(' '));
            return req.session.save(() => res.redirect(`/sales-persons/${id}/edit`));
        }
        setFlash(req, 'success', 'Sales person updated successfully.' + (loginNote ? ' ' + loginNote : ''));
        return req.session.save(() => res.redirect('/sales-persons'));
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

        // The tax split (CGST/SGST/IGST/round + taxable) comes from the API — it
        // derives them from the synced ledgers as the SINGLE source of truth, so
        // the print matches the app + the detail to the paisa (NO web-side calc).
        // The ledger loop here only finds the party (debtor/creditor) ledger name.
        const ledgers = Array.isArray(invoice.tally_ledgers) ? invoice.tally_ledgers : [];
        const tax = {
            cgst:     Number(invoice.cgst) || 0,
            sgst:     Number(invoice.sgst) || 0,
            igst:     Number(invoice.igst) || 0,
            roundoff: Number(invoice.round_off) || 0,
            sales:    Number(invoice.taxable) || 0,
        };
        let partyLedger = '';
        let _partyAbs = -1;
        ledgers.forEach((l) => {
            const nm = String(l.ledger_name || '');
            const low = nm.toLowerCase();
            const abs = Math.abs(Number(l.amount) || 0);
            if (/gst|round|sales|purchase|central|state|integrated/.test(low)) return; // skip tax/sales lines
            if (abs > _partyAbs) { partyLedger = nm; _partyAbs = abs; }                 // the debtor/creditor
        });

        // Buyer / supplier party (name + GSTIN + address). Tally-synced invoices
        // carry no FK, so fall back to the party ledger name from the voucher.
        let party = { name: (isPurchase ? invoice.supplier : invoice.customer) || partyLedger || '', gst: '', address: '' };
        const partyId = isPurchase ? invoice.supplier_id : invoice.customer_id;
        if (partyId) {
            const p = await api.get(req, `${isPurchase ? '/suppliers' : '/customers'}/${partyId}`);
            if (apiOk(p) && p.body.data) {
                party = { name: p.body.data.name, gst: p.body.data.gst_number || '',
                    address: p.body.data.billing_address || p.body.data.address || '' };
            }
        } else if (partyLedger) {
            // Match the ledger name to a cloud customer/supplier for GSTIN/address.
            const list = await fetchAllRows(req, isPurchase ? '/suppliers' : '/customers');
            const hit = list.find((x) => String(x.name || '').trim().toLowerCase() === partyLedger.trim().toLowerCase());
            if (hit) party = { name: hit.name, gst: hit.gst_number || '', address: hit.billing_address || hit.address || '' };
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
        // Prefer real invoice_items; else the reconstructed Tally inventory lines.
        const srcItems = (invoice.items && invoice.items.length) ? invoice.items : (invoice.tally_items || []);
        const items = srcItems.map((it, i) => ({
            sno: i + 1,
            name: it.item_name || it.description || prodMap[it.product_id] || 'Item',
            hsn: it.hsn || '', qty: Number(it.qty != null ? it.qty : it.quantity) || 0, unit: it.unit || '',
            rate: Number(it.rate) || 0,
            gst_rate: Number(it.gst_rate) || 0,
            disc_pct: Number(it.disc_pct) || 0,
            amount: Number(it.amount) || 0,
        }));
        // Subtotal = the API-computed taxable (single source of truth — no web calc).
        const subtotal = Number(invoice.taxable) || 0;

        res.render('invoices/print', {
            layout: false,
            heading: isPurchase ? 'PURCHASE INVOICE' : 'TAX INVOICE',
            invoice, seller, party, items, tax, subtotal,
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
        const month = String(req.query.month || '').trim();

        // ── NO MONTH → Journal Register (month-wise summary, drill-down) ──
        if (!/^\d{4}-\d{2}$/.test(month)) {
            const { rows: monthRows, meta: mMeta } = await apiList(req, '/journals/monthly');
            return res.render('journals/register', {
                title: 'Journal Register', activeMenu: 'journals',
                breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Journals' }],
                months: monthRows, grandTotal: mMeta.grand_total || 0,
            });
        }

        // ── MONTH SELECTED → that month's voucher list ──
        const [yy, mm] = month.split('-').map(Number);
        const lastDay = new Date(yy, mm, 0).getDate();
        req.query.date_from = `${month}-01`;
        req.query.date_to   = `${month}-${String(lastDay).padStart(2, '0')}`;
        const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
        const monthLabel = `${MN[mm]} ${yy}`;

        const { rows, meta } = await apiList(req, '/journals');
        const journalRows = rows.map((r) => ({
            id: r.id, voucher_no: r.voucher_no, vch_type: r.vch_type || 'Journal', date: fmtDate(r.journal_date),
            dr_ledger: r.dr_ledger, cr_ledger: r.cr_ledger, narration: r.narration || '',
            amount: r.amount, status: txStatusLabel(r.status),
        }));
        res.render('journals/list', {
            title: 'Journals · ' + monthLabel, activeMenu: 'journals',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Journal Register', href: '/journals' }, { label: monthLabel }],
            journalRows, journalsTotal: meta.total, grandTotal: meta.grand_total || 0,
            page: meta.page, perPage: meta.per_page,
            monthMode: true, monthLabel, monthValue: month,
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

/* POST /licenses/:id/delete — proxy to api DELETE (soft-delete). The confirm
 * modal in _layout.ejs POSTs here. On a refusal (still has companies/users) the
 * api's 422 message is flashed back. Returns to the list either way.
 * MUST be registered BEFORE the generic /:resource/:id/delete handler below,
 * otherwise that catch-all (which whitelists only tenant resources, NOT
 * 'licenses') would shadow this route and refuse the delete. */
router.post('/licenses/:id/delete', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.del(req, `/super-admin/licenses/${id}`);
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'License deleted.');
        else setFlash(req, 'error', apiError(result, 'Could not delete the license.'));
        return req.session.save(() => res.redirect('/licenses'));
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

/* ── PLATFORM ADMIN · e-Invoice GSP (super-admin only) ───────────
 * Per-license GSP credentials (AES-encrypted server-side) + settings. */
router.get('/einvoice-gsp', requireSuperAdmin, async (req, res, next) => {
  try {
    const licenseId = req.query.license_id || res.locals.selectedLicenseId || '';
    let gsp = { enc_configured: false, settings: {}, credentials: [] };
    if (licenseId) {
        const { body } = await api.get(req, `/super-admin/einvoice-gsp?license_id=${licenseId}`);
        gsp = (body && body.data) || gsp;
    }
    res.render('einvoice-gsp/index', {
        title: 'e-Invoice GSP',
        activeMenu: 'einvoice-gsp',
        breadcrumb: [ { label: 'Dashboard', href: '/' }, { label: 'e-Invoice GSP' } ],
        gsp, licenseId, licenses: res.locals.licenses || [],
    });
  } catch (err) { next(err); }
});

router.post('/einvoice-gsp/credential', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await api.post(req, '/super-admin/einvoice-gsp/credential', req.body);
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Saved.') : apiError(result, 'Could not save credentials.'));
    const lid = req.body.license_id ? ('?license_id=' + req.body.license_id) : '';
    return req.session.save(() => res.redirect('/einvoice-gsp' + lid));
  } catch (err) { next(err); }
});

router.post('/einvoice-gsp/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await api.post(req, '/super-admin/einvoice-gsp/settings', req.body);
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Saved.') : apiError(result, 'Could not save settings.'));
    const lid = req.body.license_id ? ('?license_id=' + req.body.license_id) : '';
    return req.session.save(() => res.redirect('/einvoice-gsp' + lid));
  } catch (err) { next(err); }
});

/* ── PLATFORM ADMIN · GPS tracking config (super-admin only) ─────
 * Per-license: master switch, capture sources, hourly interval, time window,
 * min-move de-dup + a view of the salesman location trail. */
router.get('/gps-settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const licenseId = req.query.license_id || res.locals.selectedLicenseId || '';
    let gps = {};
    if (licenseId) {
        const { body } = await api.get(req, `/super-admin/gps-settings?license_id=${licenseId}`);
        gps = ((body && body.data && body.data.settings) || {});
    }
    res.render('gps-settings/index', {
        title: 'GPS Tracking',
        activeMenu: 'gps-settings',
        breadcrumb: [ { label: 'Dashboard', href: '/' }, { label: 'GPS Tracking' } ],
        gps, licenseId, licenses: res.locals.licenses || [],
    });
  } catch (err) { next(err); }
});
router.post('/gps-settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await api.post(req, '/super-admin/gps-settings', req.body);
    setFlash(req, apiOk(result) ? 'success' : 'error',
        apiOk(result) ? ((result.body && result.body.message) || 'Saved.') : apiError(result, 'Could not save.'));
    const lid = req.body.license_id ? ('?license_id=' + req.body.license_id) : '';
    return req.session.save(() => res.redirect('/gps-settings' + lid));
  } catch (err) { next(err); }
});

/* ── PLATFORM ADMIN · Licenses (super-admin only) ────────────────
 * Cross-tenant licence management. Each route is gated by requireSuperAdmin
 * (the api also enforces super-admin, but we block here so nothing leaks).
 * The one-time license_key + auto-generated admin password are revealed on a
 * rendered success screen and are NEVER stored in the session/db/logs. */

/* GET /licenses — paginated cross-tenant licence list + a super-admin OVERVIEW
 * strip (total licences, total companies, active, expiring, connected). This is
 * the super-admin's landing/dashboard — their only "useful details" view. */
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

        // ── Overview metrics across ALL licences (not just this page). Licences
        //    are few, so one extra all-rows fetch is cheap + keeps the cards exact.
        let summary = { licenses: meta.total || licenseRows.length, companies: 0, active: 0, expiring: 0, expired: 0, connected: 0 };
        try {
            // per_page maxes at 100 in the licence list validator — 500 would 422.
            const all = await apiList({ session: req.session, query: { per_page: '100' } }, '/super-admin/licenses');
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const rowsAll = all.rows || [];
            summary.licenses = (all.meta && all.meta.total != null) ? all.meta.total : rowsAll.length;
            for (const r of rowsAll) {
                summary.companies += Number(r.companies_count || 0);
                if (r.status === 'active') summary.active += 1;
                if (r.valid_until) {
                    const vu = new Date(r.valid_until); vu.setHours(0, 0, 0, 0);
                    const days = Math.floor((vu.getTime() - today.getTime()) / 86400000);
                    if (days < 0) summary.expired += 1; else if (days <= 15) summary.expiring += 1;
                }
                if (r.last_seen_at) {
                    const seen = new Date(r.last_seen_at);
                    if ((Date.now() - seen.getTime()) < 7 * 86400000) summary.connected += 1;
                }
            }
        } catch (_) { /* non-fatal — cards fall back to page data */ }

        res.render('licenses/list', {
            title: 'Licenses',
            activeMenu: 'licenses',
            breadcrumb: [{ label: 'Overview', href: '/licenses' }, { label: 'Licenses' }],
            licenseRows, licensesTotal: meta.total, page: meta.page, perPage: meta.per_page,
            summary,
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

/* POST /licenses/:id/credentials — super-admin changes the license admin's
 * LOGIN email and/or password (proxies api PUT …/credentials). */
router.post('/licenses/:id/credentials', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const email = String(req.body.email || '').trim();
        const password = String(req.body.password || '');
        const payload = {};
        if (email) payload.email = email;
        if (password) payload.password = password;
        if (!payload.email && !payload.password) {
            setFlash(req, 'error', 'Enter a new email and/or password.');
            return req.session.save(() => res.redirect(`/licenses/${id}`));
        }
        const result = await api.put(req, `/super-admin/licenses/${id}/credentials`, payload);
        if (apiOk(result)) setFlash(req, 'success', (result.body && result.body.msg) || 'Login credentials updated.');
        else setFlash(req, 'error', apiError(result, 'Could not update the login credentials.'));
        return req.session.save(() => res.redirect(`/licenses/${id}`));
    } catch (err) { next(err); }
});

/* POST /licenses/:id/regenerate — mint a NEW key for this license (super-admin).
 * Proxies to api POST /super-admin/licenses/:id/regenerate. On success we stash
 * the returned NEW full key in a one-time session field (newLicenseKey, cleared
 * by the detail route after it renders the prominent banner) — it is NOT written
 * to the persistent flash/db/logs — and bounce back to the detail page. */
router.post('/licenses/:id/regenerate', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const result = await api.post(req, `/super-admin/licenses/${id}/regenerate`, {});
        if (apiOk(result)) {
            const data = (result.body && result.body.data) || {};
            // One-time reveal payload for the detail page (read + cleared there).
            req.session.newLicenseKey = data.license_key || '';
            setFlash(req, 'success', (result.body && result.body.msg) || 'New license key generated.');
        } else {
            setFlash(req, 'error', apiError(result, 'Could not regenerate the license key.'));
        }
        return req.session.save(() => res.redirect('/licenses/' + id));
    } catch (err) { next(err); }
});

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
            groups:     require('../lib/menuTree').groupModules(Array.isArray(data.modules) ? data.modules : []),
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

/* ── PLATFORM ADMIN · License View / Edit / Delete (super-admin only) ─────────
 * View = a read-only detail page (all license fields + the companies + users
 * lists + agent status + quick action links). Edit = a prefilled form that PUTs
 * only the mutable fields. Delete = soft-delete via the api (refused while the
 * license still owns companies/users), driven by the shared confirm-delete
 * modal which POSTs to /licenses/:id/delete. */

/* GET /licenses/:id — read-only license detail. */
router.get('/licenses/:id', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { body } = await api.get(req, `/super-admin/licenses/${id}`);
        if (!body || body.status !== 200 || !body.data) {
            setFlash(req, 'error', (body && body.msg) || 'License not found.');
            return req.session.save(() => res.redirect('/licenses'));
        }
        const d     = body.data;
        const lic   = d.license || {};
        const agent = d.agent || {};
        const machineId = lic.machine_id ? String(lic.machine_id) : '';
        // Full key reveal (super-admin only; the api already gated + decrypted).
        const keyAvailable = !!d.key_available;
        const fullKey      = keyAvailable ? (d.license_key || '') : '';
        // One-time NEW key from a just-completed Regenerate (read + clear it).
        const newLicenseKey = (req.session && req.session.newLicenseKey) || '';
        if (req.session && req.session.newLicenseKey) delete req.session.newLicenseKey;
        const license = {
            id:               lic.id,
            holder_name:      lic.holder_name || '',
            key_prefix:       lic.key_prefix ? (String(lic.key_prefix).replace(/[-\s]*$/, '') + '-…') : '—',
            // Raw prefix (un-elided) for the "full key not stored" fallback note.
            key_prefix_raw:   lic.key_prefix || '',
            key_available:    keyAvailable,
            license_key:      fullKey,
            tally_serial:     lic.tally_serial || '',
            plan:             lic.plan || 'standard',
            status:           lic.status || '',
            status_label:     lic.status === 'suspended' ? 'Suspended' : (lic.status === 'active' ? 'Active' : (lic.status || '')),
            valid_until:      lic.valid_until ? fmtDate(lic.valid_until) : '',
            max_companies:    lic.max_companies != null ? lic.max_companies : 0,
            max_users:        lic.max_users != null ? lic.max_users : 0,
            companies_count:  d.companies_count != null ? d.companies_count : 0,
            users_count:      d.users_count != null ? d.users_count : 0,
            machine_bound:    !!agent.machine_bound,
            machine_short:    machineId ? (machineId.length > 12 ? machineId.slice(0, 12) + '…' : machineId) : '',
            agent_connected:  !!agent.connected,
            agent_version:    lic.agent_version || '',
            last_seen_at:     lic.last_seen_at ? fmtDateTime(lic.last_seen_at) : '',
            machine_bound_at: lic.machine_bound_at ? fmtDateTime(lic.machine_bound_at) : '',
            created_at:       lic.created_at ? fmtDateTime(lic.created_at) : '',
        };
        const companies = (Array.isArray(d.companies) ? d.companies : []).map((c) => ({
            id: c.id, name: c.name || '', status: c.status || '',
            // Syncing flag computed by the api (first max_companies, created_at
            // asc); the rest are over the limit and do NOT sync.
            syncing: c.syncing !== false,
        }));
        const users = (Array.isArray(d.users) ? d.users : []).map((u) => ({
            id: u.id, name: u.name || '', email: u.email || '',
            role: u.role || '', status: u.status || '',
            // The license-admin is always Active and never seat-gated.
            is_license_admin: !!u.is_license_admin,
        }));
        // Reminder settings — Super-Admin per-licence Email/WhatsApp + auto switches.
        let reminderSettings = {};
        try {
            const rr = await api.get(req, `/super-admin/licenses/${req.params.id}/reminders`);
            reminderSettings = (rr.body && rr.body.data) || {};
        } catch (_) { /* leave defaults; section renders with off state */ }
        res.render('licenses/detail', {
            title: 'License — ' + (license.holder_name || ('#' + license.id)),
            activeMenu: 'licenses',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Licenses', href: '/licenses' },
                { label: license.holder_name || ('#' + license.id) },
            ],
            license, companies, users, newLicenseKey, reminderSettings,
        });
    } catch (err) { next(err); }
});

/* POST /licenses/:id/reminders — Super-Admin saves this licence's payment-
 * reminder channel switches + auto schedule. Checkboxes arrive as 'on'/absent. */
router.post('/licenses/:id/reminders', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const b = req.body || {};
        const on = (v) => v === 'on' || v === 'true' || v === true;
        const result = await api.put(req, `/super-admin/licenses/${id}/reminders`, {
            email_enabled:    on(b.email_enabled),
            whatsapp_enabled: on(b.whatsapp_enabled),
            auto_enabled:     on(b.auto_enabled),
            offsets:          b.offsets || '',
            send_hour:        b.send_hour,
        });
        if (apiOk(result)) setFlash(req, 'success', 'Reminder settings saved.');
        else setFlash(req, 'error', apiError(result, 'Could not save reminder settings.'));
        return req.session.save(() => res.redirect(`/licenses/${id}`));
    } catch (err) { next(err); }
});

/* GET /licenses/:id/edit — prefilled edit form (mutable fields only). */
router.get('/licenses/:id/edit', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { body } = await api.get(req, `/super-admin/licenses/${id}`);
        if (!body || body.status !== 200 || !body.data) {
            setFlash(req, 'error', (body && body.msg) || 'License not found.');
            return req.session.save(() => res.redirect('/licenses'));
        }
        const lic = body.data.license || {};
        res.render('licenses/edit', {
            title: 'Edit License',
            activeMenu: 'licenses',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Licenses', href: '/licenses' },
                { label: lic.holder_name || ('#' + lic.id), href: '/licenses/' + id },
                { label: 'Edit' },
            ],
            licenseId:       id,
            companiesCount:  body.data.companies_count != null ? body.data.companies_count : 0,
            usersCount:      body.data.users_count != null ? body.data.users_count : 0,
            error: null,
            old: {
                holder_name:   lic.holder_name || '',
                plan:          lic.plan || 'standard',
                max_companies: lic.max_companies != null ? lic.max_companies : '',
                max_users:     lic.max_users != null ? lic.max_users : '',
                valid_until:   lic.valid_until ? String(lic.valid_until).slice(0, 10) : '',
            },
        });
    } catch (err) { next(err); }
});

/* POST /licenses/:id/edit — proxy to api PUT (browsers can't PUT a form). On
 * success → detail page; on error re-render the form with the message + input. */
router.post('/licenses/:id/edit', requireSuperAdmin, async (req, res, next) => {
    try {
        const id  = Number(req.params.id);
        const b   = req.body;
        const num = (v) => (v === '' || v == null ? undefined : Number(v));
        const payload = {
            holder_name:   b.holder_name,
            plan:          b.plan || undefined,
            max_companies: num(b.max_companies),
            max_users:     num(b.max_users),
            // Send the raw value (incl. '') so clearing the field nulls the
            // expiry server-side; the date input is always present in the POST.
            valid_until:   b.valid_until != null ? b.valid_until : '',
        };
        const result = await api.put(req, `/super-admin/licenses/${id}`, payload);
        if (apiOk(result)) {
            setFlash(req, 'success', (result.body && result.body.msg) || 'License updated.');
            return req.session.save(() => res.redirect('/licenses/' + id));
        }
        // Re-render with the error + entered values (re-fetch usage hints best-effort).
        let companiesCount = 0; let usersCount = 0;
        try {
            const det = await api.get(req, `/super-admin/licenses/${id}`);
            if (det.body && det.body.data) {
                companiesCount = det.body.data.companies_count || 0;
                usersCount     = det.body.data.users_count || 0;
            }
        } catch (_) { /* non-fatal */ }
        return res.status(200).render('licenses/edit', {
            title: 'Edit License',
            activeMenu: 'licenses',
            breadcrumb: [
                { label: 'Dashboard', href: '/' },
                { label: 'Licenses', href: '/licenses' },
                { label: 'Edit' },
            ],
            licenseId: id, companiesCount, usersCount,
            error: apiError(result, 'Could not update the license.'),
            old: {
                holder_name:   b.holder_name, plan: b.plan,
                max_companies: b.max_companies, max_users: b.max_users,
                valid_until:   b.valid_until,
            },
        });
    } catch (err) { next(err); }
});

/* ── PLATFORM ADMIN · Agent Updates (super-admin only) ───────────
 * Upload a freshly-built TallyCloudSync.exe from the browser and publish it as
 * the current agent release. Agents with auto_update=ON self-update; agents with
 * auto_update=OFF get a "new version available" bell notification on their sync
 * dashboard. The list/publish/upload api endpoints are super-admin guarded; we
 * also gate here with requireSuperAdmin so the route/menu never leaks. */

/* Human-readable byte size (e.g. 48234567 → "46.0 MB"). */
function fmtBytes(n) {
    const b = Number(n || 0);
    if (!b) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/* GET /agent-releases — current release + publish history + upload form. */
router.get('/agent-releases', requireSuperAdmin, async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/super-admin/agent-release');
        const data    = (body && body.data) || {};
        const current = data.current || null;
        const history = Array.isArray(data.history) ? data.history : [];
        const releaseDir = data.release_dir || '';

        const mapRow = (r) => ({
            id:          r.id,
            version:     r.version || '',
            filename:    r.filename || '',
            sha256:      r.sha256 || '',
            sha256_short: r.sha256 ? String(r.sha256).slice(0, 12) : '',
            size:        fmtBytes(r.size_bytes),
            notes:       r.notes || '',
            mandatory:   !!r.mandatory,
            is_current:  !!r.is_current,
            created_at:  r.created_at ? fmtDateTime(r.created_at) : '',
        });

        res.render('agent-releases/index', {
            title: 'Agent Updates',
            activeMenu: 'agent-releases',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'Agent Updates' }],
            current:     current ? mapRow(current) : null,
            historyRows: history.map(mapRow),
            releaseDir,
        });
    } catch (err) { next(err); }
});

/* ── APP UPDATES (super-admin) — mirror of /agent-releases for the mobile APK.
 * Reuses the same 200MB in-memory multer (agentUpload) + form-data forward. */
router.get('/app-releases', requireSuperAdmin, async (req, res, next) => {
    try {
        const { body } = await api.get(req, '/super-admin/app-release');
        const data    = (body && body.data) || {};
        const current = data.current || null;
        const history = Array.isArray(data.history) ? data.history : [];
        const mapRow = (r) => ({
            id: r.id, version: r.version || '', version_code: r.version_code,
            filename: r.filename || '', sha256: r.sha256 || '',
            sha256_short: r.sha256 ? String(r.sha256).slice(0, 12) : '',
            size: fmtBytes(r.size_bytes), notes: r.notes || '',
            mandatory: !!r.mandatory, is_current: !!r.is_current,
            created_at: r.created_at ? fmtDateTime(r.created_at) : '',
        });
        res.render('app-releases/index', {
            title: 'App Updates', activeMenu: 'app-releases',
            breadcrumb: [{ label: 'Dashboard', href: '/' }, { label: 'App Updates' }],
            current: current ? mapRow(current) : null,
            historyRows: history.map(mapRow),
            releaseDir: data.release_dir || '',
            autoUpdate: data.auto_update !== false,
        });
    } catch (err) { next(err); }
});

/* POST /app-releases/auto-update — flip the GLOBAL app-auto-update master switch. */
router.post('/app-releases/auto-update', requireSuperAdmin, async (req, res, next) => {
    try {
        const enabled = String((req.body || {}).enabled || '') === 'true';
        const result = await api.post(req, '/super-admin/app-release/auto-update', { enabled });
        if (apiOk(result)) setFlash(req, 'success', `App auto-update turned ${enabled ? 'ON' : 'OFF'}.`);
        else               setFlash(req, 'error', apiError(result, 'Could not update the setting.'));
        return req.session.save(() => res.redirect('/app-releases'));
    } catch (err) { next(err); }
});

/* POST /app-releases/upload — receive the multipart apk in WEB, FORWARD it to the
 * api /super-admin/app-release/upload (form-data + session bearer). */
router.post('/app-releases/upload', requireSuperAdmin, (req, res) => {
    agentUpload(req, res, async (mErr) => {
        const back = '/app-releases';
        if (mErr) {
            const msg = mErr.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 200MB).' : 'Could not read the uploaded file.';
            setFlash(req, 'error', msg);
            return req.session.save(() => res.redirect(back));
        }
        try {
            const b = req.body || {};
            const version     = String(b.version || '').trim();
            const versionCode = String(b.version_code || '').trim();
            if (!req.file || !req.file.buffer) { setFlash(req, 'error', 'Please choose the .apk file to upload.'); return req.session.save(() => res.redirect(back)); }
            if (!/\.apk$/i.test(String(req.file.originalname || ''))) { setFlash(req, 'error', 'Only a .apk file may be uploaded.'); return req.session.save(() => res.redirect(back)); }
            if (!version)     { setFlash(req, 'error', 'A release version is required.'); return req.session.save(() => res.redirect(back)); }
            if (!versionCode) { setFlash(req, 'error', 'A build number (version code) is required.'); return req.session.save(() => res.redirect(back)); }

            const form = new FormData();
            form.append('file', req.file.buffer, {
                filename:    req.file.originalname || `TallyCloudSync-${version}.apk`,
                contentType: 'application/vnd.android.package-archive',
                knownLength: req.file.buffer.length,
            });
            form.append('version', version);
            form.append('version_code', versionCode);
            if (b.notes != null && String(b.notes).trim() !== '') form.append('notes', String(b.notes));
            if (asBool(b.mandatory)) form.append('mandatory', 'true');

            const headers = Object.assign({ Accept: 'application/json' }, form.getHeaders());
            if (req.session && req.session.token) headers.Authorization = `Bearer ${req.session.token}`;

            let parsed = null;
            try {
                const resp = await fetch(`${api.API_URL}/super-admin/app-release/upload`, { method: 'POST', headers, body: form.getBuffer() });
                try { parsed = await resp.json(); } catch { parsed = null; }
            } catch (e) {
                setFlash(req, 'error', 'Cannot reach the API server.');
                return req.session.save(() => res.redirect(back));
            }
            if (parsed && parsed.status === 200) setFlash(req, 'success', parsed.msg || `Published app v${version}.`);
            else                                 setFlash(req, 'error', (parsed && parsed.msg) || 'Could not publish the app release.');
            return req.session.save(() => res.redirect(back));
        } catch (e) {
            setFlash(req, 'error', 'Could not publish the app release.');
            return req.session.save(() => res.redirect(back));
        }
    });
});

/* POST /agent-releases/upload — receive the multipart exe in WEB, then FORWARD
 * it to the api POST /super-admin/agent-release/upload as multipart (form-data
 * + the session bearer token). The binary is streamed via form-data from the
 * in-memory Buffer so it is never corrupted. flash + redirect. */
router.post('/agent-releases/upload', requireSuperAdmin, (req, res) => {
    agentUpload(req, res, async (mErr) => {
        const back = '/agent-releases';
        if (mErr) {
            const msg = mErr.code === 'LIMIT_FILE_SIZE'
                ? 'The file is too large (max 200MB).'
                : 'Could not read the uploaded file.';
            setFlash(req, 'error', msg);
            return req.session.save(() => res.redirect(back));
        }
        try {
            const b = req.body || {};
            const version = String(b.version || '').trim();
            if (!req.file || !req.file.buffer) {
                setFlash(req, 'error', 'Please choose the agent .exe file to upload.');
                return req.session.save(() => res.redirect(back));
            }
            if (!/\.exe$/i.test(String(req.file.originalname || ''))) {
                setFlash(req, 'error', 'Only a .exe agent file may be uploaded.');
                return req.session.save(() => res.redirect(back));
            }
            if (!version) {
                setFlash(req, 'error', 'A release version is required.');
                return req.session.save(() => res.redirect(back));
            }

            // Build the multipart body for the api. The file rides as the "file"
            // field (filename + octet-stream content-type) from the Buffer; the
            // text fields ride alongside it.
            const form = new FormData();
            form.append('file', req.file.buffer, {
                filename: req.file.originalname || `TallyCloudSync-${version}.exe`,
                contentType: 'application/octet-stream',
                knownLength: req.file.buffer.length,
            });
            form.append('version', version);
            if (b.notes != null && String(b.notes).trim() !== '') form.append('notes', String(b.notes));
            if (asBool(b.mandatory)) form.append('mandatory', 'true');

            const headers = Object.assign({ Accept: 'application/json' }, form.getHeaders());
            if (req.session && req.session.token) headers.Authorization = `Bearer ${req.session.token}`;

            let resp; let parsed = null;
            try {
                resp = await fetch(`${api.API_URL}/super-admin/agent-release/upload`, {
                    method: 'POST',
                    headers,
                    body: form.getBuffer(),
                });
                try { parsed = await resp.json(); } catch { parsed = null; }
            } catch (e) {
                setFlash(req, 'error', 'Cannot reach the API server.');
                return req.session.save(() => res.redirect(back));
            }

            const ok = parsed && parsed.status === 200;
            if (ok) {
                setFlash(req, 'success', parsed.msg || `Published agent v${version}.`);
            } else {
                setFlash(req, 'error', (parsed && parsed.msg) || 'Could not publish the agent release.');
            }
            return req.session.save(() => res.redirect(back));
        } catch (err) {
            setFlash(req, 'error', 'Could not publish the agent release.');
            return req.session.save(() => res.redirect(back));
        }
    });
});

module.exports = router;
