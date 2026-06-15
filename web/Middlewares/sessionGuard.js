'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/Middlewares/sessionGuard.js
 *
 * requireAuth — gate the app behind a logged-in session. If there is no
 * Bearer token on the session, an HTML navigation is redirected to
 * /login (with ?next= so we can bounce back after login); an AJAX/JSON
 * request gets a 401 envelope instead of an HTML redirect.
 * ─────────────────────────────────────────────────────────── */

function wantsJson(req) {
    return req.xhr ||
        (req.headers.accept || '').indexOf('application/json') !== -1 ||
        (req.headers['x-requested-with'] === 'XMLHttpRequest');
}

function requireAuth(req, res, next) {
    if (req.session && req.session.token) return next();

    if (wantsJson(req)) {
        return res.status(401).json({ status: 401, show: true, msg: 'Please log in to continue.' });
    }
    const next_ = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${next_}`);
}

module.exports = { requireAuth };
