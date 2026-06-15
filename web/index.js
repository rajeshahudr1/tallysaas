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

// Header initials fallback (e.g. "Rajesh Admin" → "RA").
function initialsOf(name) {
    return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}

const app    = express();
const ENV    = process.env.NODE_ENV || 'development';
const IS_DEV = ENV !== 'production';
const PORT   = parseInt(process.env.PORT, 10) || 4600;

app.disable('x-powered-by');

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

/* ── Form bodies + session ──────────────────────────────────────
 * urlencoded parses the login form POST; express-session holds the JWT
 * + signed-in user after login (see Controllers/AuthController.js).
 * ─────────────────────────────────────────────────────────── */
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
    name: 'tcs.sid',
    secret: process.env.SESSION_SECRET || 'tcs-dev-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }, // 8h
}));

/* ── Global view locals ─────────────────────────────────────────
 * Header/identity data comes from the SESSION once logged in (the
 * signed-in user from the api); before login it falls back to the mock
 * values so the standalone login page still renders. Page routes
 * override title/activeMenu/breadcrumb as needed.
 * ─────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
    // One-shot flash message (set by POST handlers, shown on the next page).
    res.locals.flash = (req.session && req.session.flash) || null;
    if (req.session && req.session.flash) delete req.session.flash;

    const u = req.session && req.session.user;
    if (u) {
        res.locals.user = {
            name: u.name || 'User',
            role: u.role || u.role_slug || '',
            avatar: '/img/avatar.svg',
            initials: initialsOf(u.name),
        };
    } else {
        res.locals.user = mock.user;
    }
    // Company switcher — real, license-scoped companies stored on the session
    // at login (fall back to mock before login so the standalone pages render).
    res.locals.companies = (req.session && Array.isArray(req.session.companies) && req.session.companies.length)
        ? req.session.companies : mock.companies;
    res.locals.company = (req.session && req.session.companyId != null)
        ? { id: req.session.companyId, name: req.session.companyName || 'Company' }
        : mock.company;
    res.locals.notificationCount = mock.notificationCount;

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
