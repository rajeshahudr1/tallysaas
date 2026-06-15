'use strict';

/**
 * api/Helpers/response.js
 *
 * The single source of truth for the TallySaaS JSON response envelope plus a
 * couple of tiny time/id helpers. Conventionally imported as
 * `const R = require('../Helpers/response')`.
 *
 * Envelope shape (mirrors the IOT house style):
 *
 *   success: { status: 200, show: false, msg: "success", data: <any> }
 *   error  : { status: <code>, show: true,  msg: "<reason>" }
 *
 * The HTTP status stays 200 for LOGICAL results — the meaningful code lives in
 * `body.status` so clients read one field everywhere. Real HTTP codes are used
 * only for transport-level outcomes (/health 503, 404 routing, 500 uncaught),
 * which are emitted directly by index.js / errorHandler.js.
 *
 * Field names "msg" (NOT "message") and "show" (NOT "success") are part of the
 * frozen contract — do not rename.
 */

const { randomUUID } = require('node:crypto');

// ───────────────────────────────────────────────────────────────────
// Response envelopes
// ───────────────────────────────────────────────────────────────────

/**
 * Send a 200-OK success envelope.
 *
 * @param {import('express').Response} res
 * @param {*}      data   payload (object/array); omitted from the body if undefined
 * @param {string} [msg]  display message (default "success")
 * @param {object} [extra] extra top-level fields (e.g. { meta: {...} })
 */
function successResponse(res, data, msg = 'success', extra = {}) {
    const body = { status: 200, show: false, msg };
    if (data !== undefined) body.data = data;
    return res.status(200).json({ ...body, ...extra });
}

/**
 * Send an error envelope. HTTP status stays 200 so clients read body.status;
 * the logical code (422 / 401 / 403 / 404 / 500 …) lives in the body.
 *
 * @param {import('express').Response} res
 * @param {string} msg     user-facing message
 * @param {number} [status] logical status code in the body (default 422)
 * @param {object} [extra]  extra top-level fields if needed
 */
function errorResponse(res, msg, status = 422, extra = {}) {
    return res.status(200).json({ status, show: true, msg, ...extra });
}

// ───────────────────────────────────────────────────────────────────
// Time
// ───────────────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD HH:mm:ss" in UTC. Handy for response payloads and for setting
 * `updated_at` explicitly when not letting PostgreSQL apply its default.
 */
function now() {
    const d   = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ───────────────────────────────────────────────────────────────────
// UUID
// ───────────────────────────────────────────────────────────────────

/**
 * RFC 4122 v4 UUID via Node's built-in crypto. Used for the per-request id
 * and anywhere an opaque unique token is needed.
 */
function uuid() {
    return randomUUID();
}

module.exports = {
    successResponse,
    errorResponse,
    now,
    uuid,
};
