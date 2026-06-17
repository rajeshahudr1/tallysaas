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
    return { status: resp.status, body: parsed };
}

// Convenience verbs.
const get   = (req, path)       => callApi(req, 'GET', path);
const post  = (req, path, body) => callApi(req, 'POST', path, body);
const put   = (req, path, body) => callApi(req, 'PUT', path, body);
const patch = (req, path, body) => callApi(req, 'PATCH', path, body);
const del   = (req, path)       => callApi(req, 'DELETE', path);

module.exports = { callApi, get, post, put, patch, del, API_URL };
