'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/Helpers/apiClient.js
 *
 * Thin wrapper around Node 20+'s built-in fetch() that forwards
 * web/ → api/ calls. This is the BFF (backend-for-frontend) seam: EJS
 * route handlers call these helpers instead of reading data/mock.js, so
 * the SAME REST API also serves a future mobile app.
 *
 * Reads per-request auth from the session (set at login):
 *   • Bearer token  → req.session.token
 *   • Company scope → req.session.companyId  (sent as X-Company-Id; the
 *                     api's resolveCompany honours it for Super Admins)
 *   • api base URL  → process.env.API_URL (default http://localhost:4500/api/v1)
 *
 * Returns { status, body } where body is the parsed JSON envelope
 * ({ status, show, msg, data }). On a transport failure: status 0 +
 * networkError. The api keeps HTTP 200 for logical errors and carries the
 * real code in body.status, so callers check body.status, not `status`.
 * ─────────────────────────────────────────────────────────── */

const API_URL = (process.env.API_URL || 'http://localhost:4500/api/v1').replace(/\/$/, '');

async function callApi(req, method, path, body) {
    const headers = { Accept: 'application/json' };

    if (req && req.session && req.session.token) {
        headers.Authorization = `Bearer ${req.session.token}`;
    }
    if (req && req.session && req.session.companyId != null) {
        headers['X-Company-Id'] = String(req.session.companyId);
    }

    let payload;
    if (body !== undefined && body !== null) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }

    let resp;
    try {
        resp = await fetch(`${API_URL}${path}`, { method, headers, body: payload });
    } catch (err) {
        return { status: 0, body: null, networkError: err.message };
    }

    let parsed = null;
    try { parsed = await resp.json(); } catch { /* non-JSON response */ }
    // The backend rejected our (previously valid) token → the session has ended
    // (expired / evicted / single-session eviction). Surface it so the error
    // handler clears the web session and redirects to /login instead of rendering
    // a dead page. The login call itself carries no token, so it is exempt.
    //
    // CRITICAL: the api uses the "HTTP 200 + body.status" envelope, so an auth
    // failure comes back as HTTP 200 with body.status === 401 — NOT a real HTTP
    // 401. We must check BOTH, or the timeout→/login redirect never fires (this
    // was the long-standing "session timeout doesn't log me out" bug).
    const envelope401 = parsed && Number(parsed.status) === 401;
    if ((resp.status === 401 || envelope401) && req && req.session && req.session.token) {
        const e = new Error('Session ended');
        e.code = 'SESSION_ENDED';
        throw e;
    }
    return { status: resp.status, body: parsed };
}

// Convenience verbs.
const get   = (req, path)       => callApi(req, 'GET', path);
const post  = (req, path, body) => callApi(req, 'POST', path, body);
const put   = (req, path, body) => callApi(req, 'PUT', path, body);
const patch = (req, path, body) => callApi(req, 'PATCH', path, body);
const del   = (req, path)       => callApi(req, 'DELETE', path);

/**
 * GET a BINARY response (e.g. a server-rendered PDF) with the same auth +
 * company headers, returning the raw bytes so a BFF route can stream it to the
 * browser. Returns { status, contentType, buffer } (buffer null on failure).
 */
async function fetchBinary(req, path) {
    const headers = { Accept: '*/*' };
    if (req && req.session && req.session.token) {
        headers.Authorization = `Bearer ${req.session.token}`;
    }
    if (req && req.session && req.session.companyId != null) {
        headers['X-Company-Id'] = String(req.session.companyId);
    }
    let resp;
    try {
        resp = await fetch(`${API_URL}${path}`, { method: 'GET', headers });
    } catch (err) {
        return { status: 0, contentType: '', buffer: null, networkError: err.message };
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, contentType: resp.headers.get('content-type') || '', buffer };
}

module.exports = { callApi, get, post, put, patch, del, fetchBinary, API_URL };
