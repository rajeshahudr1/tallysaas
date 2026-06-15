'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/Controllers/AuthController.js
 *
 * Session-based auth for the web tier. There is NO local user store —
 * login proxies to the api's POST /auth/login; on success the returned
 * JWT + user are stashed on the session and every later page/apiClient
 * call rides that token.
 * ─────────────────────────────────────────────────────────── */

const api = require('../Helpers/apiClient');

// GET /login — show the form (skip if already authenticated).
function showLogin(req, res) {
    if (req.session && req.session.token) return res.redirect('/');
    res.render('auth/login', {
        layout: false,
        title: 'Sign in',
        error: null,
        email: '',
        next: typeof req.query.next === 'string' ? req.query.next : '/',
    });
}

// POST /login — exchange credentials with the api for a JWT.
async function login(req, res) {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const next = (typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/';

    const rerender = (error) => res.status(200).render('auth/login', {
        layout: false, title: 'Sign in', error, email, next,
    });

    if (!email || !password) return rerender('Enter your email and password.');

    const { status, body, networkError } = await api.callApi(req, 'POST', '/auth/login', { email, password });

    if (networkError || status === 0) {
        return rerender('Cannot reach the server. Is the API running?');
    }
    // The api keeps HTTP 200 and carries the real code in body.status.
    if (!body || body.status !== 200 || !body.data || !body.data.token) {
        return rerender((body && body.msg) || 'Email or password is incorrect.');
    }

    const user = body.data.user || {};
    req.session.token = body.data.token;
    req.session.user  = user;

    // Fetch the companies this user may switch between (license-scoped; super
    // admin = all) so the header switcher + /switch-company are populated.
    let companies = [];
    try {
        const mc = await api.callApi(req, 'GET', '/my-companies');
        if (mc.body && mc.body.status === 200 && mc.body.data && Array.isArray(mc.body.data.data)) {
            companies = mc.body.data.data.map((c) => ({ id: c.id, name: c.name }));
        }
    } catch (_) { /* non-fatal — header falls back to defaults */ }
    req.session.companies = companies;

    // Current company: the user's own if set, else the first accessible, else 1.
    const ownId = user.company_id != null
        ? user.company_id
        : (companies[0] ? companies[0].id : 1);
    req.session.companyId   = ownId;
    const cur = companies.find((c) => Number(c.id) === Number(ownId));
    req.session.companyName = cur ? cur.name : (companies[0] ? companies[0].name : 'Company');

    // Persist the session before redirecting (avoids a race where the
    // cookie isn't written yet).
    req.session.save(() => res.redirect(next));
}

// GET /logout — drop the session.
function logout(req, res) {
    req.session.destroy(() => res.redirect('/login'));
}

module.exports = { showLogin, login, logout };
