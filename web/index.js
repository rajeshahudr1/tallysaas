'use strict';

/* ─────────────────────────────────────────────────────────────
 * index.js — Express bootstrap for the Tally Cloud Sync web tier
 * (Phase 1, UI-only). See docs/PHASE-1-UI-SPEC.md §8.
 *
 * Responsibilities:
 *   • EJS view engine + express-ejs-layouts (single _layout shell).
 *   • Static asset serving from /public (css, js, img, icons, PWA).
 *   • Sensible middleware: morgan (dev logs), compression, helmet.
 *   • res.locals defaults (user/company/companies/notificationCount…)
 *     pulled from the mock layer so every render has header data.
 *   • Mount the page routes (routes/web.js).
 *   • A friendly 404 handler + a clean startup banner.
 *
 * NO backend / DB / auth in this phase — pages render from mock data.
 * ─────────────────────────────────────────────────────────── */

// dotenv is optional in this UI-only phase (only PORT matters). Load it
// if present, but never hard-fail the boot when the package isn't installed.
try { require('dotenv').config(); } catch (_) { /* dotenv not installed — fine */ }

const path         = require('path');
const express      = require('express');
const expressLayouts = require('express-ejs-layouts');
const session      = require('express-session');
const morgan       = require('morgan');
const compression  = require('compression');
const helmet       = require('helmet');

const mock = require('./data/mock');
const api  = require('./Helpers/apiClient');

// Header initials fallback (e.g. "Rajesh Admin" → "RA").
function initialsOf(name) {
    return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}

const app    = express();
const ENV    = process.env.NODE_ENV || 'development';
const IS_DEV = ENV !== 'production';
const PORT   = parseInt(process.env.PORT, 10) || 4600;

app.disable('x-powered-by');

// Trust the reverse proxy (Nginx / cPanel / Cloudflare) that sits in front of
// Node so Express reads the real client IP + the original protocol
// (X-Forwarded-Proto). REQUIRED for `cookie.secure` to work behind HTTPS
// termination — without it express-session silently refuses to set a secure
// cookie and login loops forever. `1` = trust the first hop.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1', 10));

/* ── View engine + layouts ──────────────────────────────────── */
// express-ejs-layouts wraps every rendered view inside views/_layout.ejs.
// Pages render their content into `<%- body %>`; per-page <script> blocks
// flow through the `pageScript` local (see _layout.ejs).
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', '_layout');
// Let pages contribute extra <head>/<script> via named sections if desired.
app.set('layout extractScripts', false);
app.set('layout extractStyles', false);

/* ── Security headers ───────────────────────────────────────────
 * helmet() ships sane defaults. We DISABLE its Content-Security-Policy
 * for this UI-only CDN demo: the page pulls Bootstrap, Font Awesome,
 * Inter and Chart.js from public CDNs and uses a few inline init
 * scripts / styles. A strict CSP would block those without a nonce
 * pipeline that isn't worth building before a real backend exists.
 * When the API tier lands, re-enable CSP with an allow-list for the
 * specific CDNs + nonces for inline scripts.
 * ─────────────────────────────────────────────────────────── */
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

/* ── Performance + logging ──────────────────────────────────── */
app.use(compression());
if (IS_DEV) app.use(morgan('dev'));

/* ── Static assets ──────────────────────────────────────────────
 * service-worker.js needs root scope + must never be cached stale,
 * so we attach the right headers when it's served.
 * ─────────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(path.sep + 'service-worker.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    },
}));

/* ── NO PAGE CACHE ───────────────────────────────────────────────
 * The app is SESSION-driven and data changes constantly (edits, uploads,
 * syncs). Every navigation/page must reflect the latest data + UI immediately,
 * so we send no-store on every rendered HTML response (NOT static assets, which
 * are served above). This kills the "I changed it but the old page still shows"
 * class of problems (e.g. a stale Edit button / list). ─────────── */
app.use((req, res, next) => {
    if (req.method === 'GET'
        && !/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|webmanifest|map)(\?|$)/i.test(req.path)) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.set('Surrogate-Control', 'no-store');
    }
    next();
});

/* ── Form bodies + session ──────────────────────────────────────
 * urlencoded parses the login form POST; express-session holds the JWT
 * + signed-in user after login (see Controllers/AuthController.js).
 *
 * SESSION STORE — the production fix: the default in-memory MemoryStore
 * drops EVERY session on a Node restart AND scatters sessions across PM2
 * cluster workers. The symptom is exactly "login succeeds, then the
 * dashboard 302s back to /login" — the login saved the session in one
 * worker's RAM, the next request hit another worker that has no session.
 * We persist sessions in the SAME PostgreSQL the api uses, via
 * connect-pg-simple (a tiny dedicated pool; the `sessions` table is
 * auto-created). Mirrors the proven TempleManagement deployment.
 * ─────────────────────────────────────────────────────────── */
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const pgSession = require('connect-pg-simple')(session);
app.use(session({
    name: 'tcs.sid',
    secret: process.env.SESSION_SECRET || 'tcs-dev-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: new pgSession({
        // Reuse the api's PostgreSQL (same DB_* env values). A small dedicated
        // pool just for sessions — no second app DB layer needed in the BFF.
        conObject: {
            host:     process.env.DB_HOST     || '127.0.0.1',
            port:     parseInt(process.env.DB_PORT, 10) || 5432,
            database: process.env.DB_DATABASE || 'tallysaas',
            user:     process.env.DB_USERNAME || 'postgres',
            password: process.env.DB_PASSWORD || '',
            ssl: process.env.DB_SSL === 'true'
                ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
                : false,
        },
        tableName:            'sessions',
        createTableIfMissing: true,      // lazily CREATE the sessions table
        pruneSessionInterval:  60 * 60 * 24,   // prune expired rows daily (no cron)
    }),
    cookie: {
        httpOnly: true,
        // secure:true → the browser sends the cookie ONLY over HTTPS. Behind
        // Nginx that needs trust-proxy ON + X-Forwarded-Proto:https, else
        // express-session silently drops Set-Cookie and login loops. Default
        // OFF; set COOKIE_SECURE=true in .env only after confirming the proxy
        // forwards the header (watch the SESSION_DEBUG output below).
        secure:   process.env.COOKIE_SECURE === 'true',
        sameSite: 'lax',
        maxAge:   parseInt(process.env.SESSION_MAX_AGE, 10) || 1000 * 60 * 60 * 8, // 8h
    },
}));

/* ── Session diagnostics (TOGGLEABLE — set SESSION_DEBUG=1) ──────
 * One line per request so a LIVE login problem is diagnosable from the
 * server logs alone (send these to me and I can pinpoint it):
 *   • cookieSent=false on a page after login → browser never stored the
 *     cookie (secure-cookie / sameSite / proxy issue)
 *   • cookieSent=true but hasUser=false      → cookie returned but the session
 *     was lost in the store (MemoryStore restart / unshared workers)
 *   • secure=false while xfproto=https        → trust-proxy / header not effective
 * Turn OFF (SESSION_DEBUG=0) once login is stable.
 * ─────────────────────────────────────────────────────────── */
if (process.env.SESSION_DEBUG === '1') {
    app.use((req, res, next) => {
        const sid        = req.sessionID ? String(req.sessionID).slice(0, 8) : 'none';
        const hasUser    = !!(req.session && req.session.user);
        const hasToken   = !!(req.session && req.session.token);
        const cookieSent = (req.headers.cookie || '').includes('tcs.sid=');
        const xfproto    = req.headers['x-forwarded-proto'] || '-';
        console.log('[SESSION]', (req.method + ' ' + req.url).slice(0, 38).padEnd(38),
            'sid=' + sid, 'cookieSent=' + cookieSent, 'hasToken=' + hasToken,
            'hasUser=' + hasUser, 'secure=' + req.secure, 'xfproto=' + xfproto);
        next();
    });
}

/* ── Global view locals ─────────────────────────────────────────
 * Header/identity data comes from the SESSION once logged in (the
 * signed-in user from the api); before login it falls back to the mock
 * values so the standalone login page still renders. Page routes
 * override title/activeMenu/breadcrumb as needed.
 * ─────────────────────────────────────────────────────────── */
app.use(async (req, res, next) => {
    // One-shot flash message (set by POST handlers, shown on the next page).
    res.locals.flash = (req.session && req.session.flash) || null;
    if (req.session && req.session.flash) delete req.session.flash;

    const u = req.session && req.session.user;
    if (u) {
        res.locals.user = {
            name: u.name || 'User',
            role: u.role || u.role_slug || '',
            role_slug: u.role_slug || '',
            avatar: '/img/avatar.svg',
            initials: initialsOf(u.name),
        };
    } else {
        res.locals.user = mock.user;
    }
    // Super-admin flag — drives the cross-tenant "Licenses" sidebar item and
    // the super-admin route guard. Derived from the session user's role slug.
    res.locals.isSuperAdmin = !!(u && u.role_slug === 'super-admin');
    // License-admin (tenant) flag — drives the tenant "Roles" sidebar item and
    // the company-admin route guard. Derived from the session user's role slug.
    res.locals.isCompanyAdmin = !!(u && u.role_slug === 'company-admin');
    // ── Permission set + can(module) helper — drives the menu/dashboard RBAC.
    //    Admins (super / company) see EVERYTHING for their scope; every other
    //    user sees ONLY the modules their role grants a '<module>.view' on. The
    //    sidebar + dashboard cards both filter through res.locals.can(). ──
    const _perms = new Set((u && Array.isArray(u.permissions)) ? u.permissions : []);
    const _allAccess = (u && u.role_slug === 'super-admin')
        || (u && u.role_slug === 'company-admin') || _perms.has('*');
    res.locals.permissions = _perms;
    res.locals.canModule = (mod) => _allAccess
        || _perms.has(`${mod}.view`) || _perms.has(`${mod}.manage`);
    // ── Top switcher — ROLE-AWARE, ALWAYS FRESH ──────────────────────
    //   • super-admin   → TWO levels: a LICENSE dropdown + a COMPANY dropdown
    //                     for the SELECTED license (defaults to the first).
    //   • everyone else → ONE level: the COMPANY dropdown for their license
    //                     (their license is implicit from login → hidden).
    // Whatever company ends up selected is pinned to req.session.companyId so
    // apiClient sends X-Company-Id and every page shows THAT company's data.
    // No mock fallback once logged in: an empty account shows an empty switcher,
    // never stale demo data.
    let licenses = [];            // super-admin only
    let companies = [];           // companies of the selected/own license
    let selectedLicenseId = null; // super-admin only

    if (u && req.session && req.session.token) {
        try {
            if (res.locals.isSuperAdmin) {
                const lr = await api.callApi(req, 'GET', '/super-admin/licenses?per_page=100');
                if (lr.body && lr.body.status === 200 && lr.body.data && Array.isArray(lr.body.data.data)) {
                    licenses = lr.body.data.data.map((l) => ({ id: l.id, name: l.holder_name || ('License ' + l.id) }));
                }
                // Selected license: the session's choice if still valid, else the first.
                const sel = licenses.find((l) => Number(l.id) === Number(req.session.licenseId)) || licenses[0] || null;
                selectedLicenseId = sel ? sel.id : null;
                if (selectedLicenseId != null) {
                    const cr = await api.callApi(req, 'GET', '/my-companies?license_id=' + encodeURIComponent(selectedLicenseId));
                    if (cr.body && cr.body.status === 200 && cr.body.data && Array.isArray(cr.body.data.data)) {
                        companies = cr.body.data.data.map((c) => ({ id: c.id, name: c.name }));
                    }
                }
            } else {
                const cr = await api.callApi(req, 'GET', '/my-companies');
                if (cr.body && cr.body.status === 200 && cr.body.data && Array.isArray(cr.body.data.data)) {
                    companies = cr.body.data.data.map((c) => ({ id: c.id, name: c.name }));
                }
            }
        } catch (_) { /* non-fatal — empty switcher below */ }
    }

    // Persist resolved selection so the switch routes + apiClient stay in sync.
    if (res.locals.isSuperAdmin) req.session.licenseId = selectedLicenseId;
    req.session.companies = companies;

    // Selected company: the session's choice if still in the list, else the first.
    const selCompany = companies.find((c) => Number(c.id) === Number(req.session.companyId)) || companies[0] || null;
    req.session.companyId = selCompany ? selCompany.id : null;   // pin → X-Company-Id

    res.locals.licenses          = licenses;
    res.locals.selectedLicenseId = selectedLicenseId;
    res.locals.selectedLicense   = licenses.find((l) => Number(l.id) === Number(selectedLicenseId)) || null;
    res.locals.companies         = companies;
    res.locals.company           = selCompany ? { id: selCompany.id, name: selCompany.name } : null;

    // ── Notification BELL — REAL sync activity (no mock) ─────────────────
    // Drive the header bell from GET /sync/notifications (company-scoped). The
    // badge = failed/unread count in the last 24h; the dropdown lists the recent
    // rows with friendly reasons. Only call when logged in with a resolved
    // company; on ANY error fall back to 0 / [] (never to mock data). Non-fatal:
    // a sync-feed hiccup must never break page rendering.
    res.locals.notificationCount = 0;
    res.locals.syncNotifs        = [];
    if (u && req.session && req.session.token && req.session.companyId != null) {
        try {
            const nr = await api.callApi(req, 'GET', '/sync/notifications');
            if (nr.body && nr.body.status === 200 && nr.body.data) {
                const d = nr.body.data;
                res.locals.notificationCount = Number(d.unread) || 0;
                res.locals.syncNotifs = Array.isArray(d.recent) ? d.recent : [];
            }
        } catch (_) { /* non-fatal — keep the 0 / [] defaults above */ }
    }

    // Layout / page defaults (overridden per route).
    res.locals.title      = 'Tally Cloud Sync';
    res.locals.activeMenu = '';
    res.locals.breadcrumb = [];
    res.locals.pageScript = '';

    // Current path + query — used by pagination links + the filter card to
    // build real GET URLs that preserve existing filters.
    res.locals.currentPath  = req.path;
    res.locals.currentQuery = req.query || {};
    next();
});

/* ── Page routes ────────────────────────────────────────────── */
app.use('/', require('./routes/web'));

/* ── 404 handler ────────────────────────────────────────────── */
// Render a dedicated, lightweight Not-Found page (NOT the dashboard) so
// the response is unambiguous and needs no chart/page data.
app.use((req, res) => {
    res.status(404).render('errors/404', {
        title: 'Page Not Found',
        activeMenu: '',
        breadcrumb: [
            { label: 'Dashboard', href: '/' },
            { label: 'Not Found' },
        ],
    });
});

/* ── Error handler ──────────────────────────────────────────── */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[error]', err && (err.stack || err.message || err));
    res.status(500).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>500</title>' +
        '<style>body{font:15px/1.5 Inter,system-ui;display:grid;place-items:center;' +
        'height:100vh;margin:0;color:#111827}h1{font-size:48px;margin:0 0 .25em;color:#2563EB}' +
        'p{color:#6B7280}</style>' +
        '<div style="text-align:center"><h1>500</h1><p>Something went wrong.</p></div>'
    );
});

/* ── Boot ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  ☁  Tally Cloud Sync — Web (UI-only)');
    console.log('  ──────────────────────────────────────────');
    console.log(`     URL  : ${url}`);
    console.log(`     Env  : ${ENV}`);
    console.log('     Data : mock (data/mock.js)');
    console.log('  ──────────────────────────────────────────');
    console.log('');
});

module.exports = app;
