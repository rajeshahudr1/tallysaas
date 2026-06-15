'use strict';

/**
 * api/Middlewares/errorHandler.js
 *
 * The two terminal handlers mounted LAST in index.js (after the Routes):
 *
 *   notFound      — any request that fell through all routes. Emits a 404
 *                   envelope with a REAL HTTP 404 so proxies/probes see a
 *                   genuine not-found.
 *
 *   errorHandler  — Express's 4-arg central error handler. Catches anything
 *                   thrown/`next(err)`-ed in the pipeline and emits a 500
 *                   envelope with a REAL HTTP 500. In development it also
 *                   surfaces the underlying message to ease debugging; in
 *                   production it stays generic.
 *
 * These two are the ONLY places (besides /health) that intentionally diverge
 * from the "HTTP 200 + body.status" convention — a 404/500 here is a transport
 * outcome, not a logical one.
 */

const IS_DEV = (process.env.APP_ENV || 'development') !== 'production';

/**
 * 404 — no route matched. Real HTTP 404, envelope body.
 */
function notFound(req, res) {
    return res.status(404).json({
        status: 404,
        show:   true,
        msg:    'Route not found',
    });
}

/**
 * Central error handler. MUST keep the 4-arg signature so Express recognises
 * it as an error handler even though `next` is unused.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    // Log with the request id (set by the requestId middleware) for tracing.
    const rid = req && req.requestId ? req.requestId.slice(0, 8) : '--------';
    console.error(`[${rid}] Unhandled error:`, err && (err.stack || err.message || err));

    const payload = {
        status: 500,
        show:   true,
        msg:    'Oops..Something went wrong. Please try again.',
    };
    if (IS_DEV && err) payload.error = err.message;
    return res.status(500).json(payload);
}

module.exports = { notFound, errorHandler };
