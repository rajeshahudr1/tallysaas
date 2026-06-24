'use strict';

// Run on Indian Standard Time (IST) so every Date format + log line is local.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

/**
 * api/index.js
 *
 * Express bootstrap for the TallySaaS API. Single PostgreSQL database with
 * row-level multi-tenancy (`company_id` on every tenant table) — no master/
 * tenant split.
 *
 * Pipeline (in order):
 *   1. pg INT8 type-parser → JS Number (set ONCE, before anything queries).
 *   2. helmet                 — security headers (API serves JSON only).
 *   3. cors                   — allowlist from CORS_ORIGIN ('*' = any).
 *   4. compression            — gzip responses over the threshold.
 *   5. express.json (2 MB)    — body parsing.
 *   6. requestId              — a per-request uuid on req + response header.
 *   7. Routes mounted at /api/v1 (includes /ping and /health).
 *   8. notFound (404) + central errorHandler (500).
 *
 * Exports the app (for tests) and calls app.listen(PORT) with a boot banner.
 */

require('dotenv').config();

// ── PG bigint (INT8) → JS Number ────────────────────────────────
// node-postgres returns INT8 as a STRING by default to avoid precision loss.
// Our ids and counts sit far below 2^53, so we coerce to Number ONCE at boot
// for clean JSON. (Anything that could exceed 2^53 should stay a string —
// none of our columns do.)
const pgTypes = require('pg').types;
pgTypes.setTypeParser(pgTypes.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');

const { uuid }                  = require('./Helpers/response');
const { notFound, errorHandler } = require('./Middlewares/errorHandler');

const app    = express();
const ENV    = process.env.APP_ENV || 'development';
const IS_DEV = ENV !== 'production';
const PORT   = parseInt(process.env.PORT, 10) || 4500;

// ── Behind a proxy (nginx / PM2 / managed host) ─────────────────
app.set('trust proxy', true);
app.disable('x-powered-by');

// ── Security headers ─────────────────────────────────────────────
// The API serves JSON only, so we lock the CSP to default-src 'none' and
// deny framing. Defaults from helmet() cover the rest.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            'default-src':     ["'none'"],
            'frame-ancestors': ["'none'"],
        },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard:               { action: 'deny' },
}));

// ── CORS allowlist ───────────────────────────────────────────────
//   dev : CORS_ORIGIN=*                          (any origin)
//   prod: CORS_ORIGIN=https://a.com,https://b.com (comma-separated)
const corsOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

app.use(cors({
    origin:      corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    // Super Admin company override + auth header need to be allowed.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id'],
}));

// ── Response compression ─────────────────────────────────────────
// Skip tiny payloads (< 1 KB) — gzip overhead makes them net-larger. Honour
// an opt-out header for clients that don't want transforms.
app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    },
}));

// ── Body parsing ─────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Request id ───────────────────────────────────────────────────
// A uuid on every request — attached to req and echoed in a response header
// so clients (and our error handler) can quote it when reporting issues.
app.use((req, res, next) => {
    req.requestId = uuid();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// ── Dev request logger ───────────────────────────────────────────
if (IS_DEV) {
    app.use((req, res, next) => {
        console.log(
            `[${new Date().toISOString()}]`,
            req.requestId.slice(0, 8),
            req.method.padEnd(6),
            req.originalUrl,
        );
        next();
    });
}

// ── API router (mounted at /api/v1; defines /ping, /health, /auth, /customers) ──
app.use('/api/v1', require('./Routes'));

// ── Terminal handlers — 404 then central error handler ──────────
app.use(notFound);
app.use(errorHandler);

// ── Boot ─────────────────────────────────────────────────────────
const { pingWithRetry } = require('./config/db');

const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log('');
    console.log(`  TallySaaS API running`);
    console.log(`      URL   : http://localhost:${PORT}`);
    console.log(`      Ping  : http://localhost:${PORT}/api/v1/ping`);
    console.log(`      Env   : ${ENV}`);

    const dbHost = process.env.DB_HOST     || '127.0.0.1';
    const dbPort = process.env.DB_PORT     || 5432;
    const dbName = process.env.DB_DATABASE || 'tallysaas';

    // Retry-with-backoff so a slow/racy DB startup doesn't crash the boot;
    // we keep serving DB-less endpoints (/ping) either way.
    try {
        const attempts = await pingWithRetry({
            maxAttempts: Number(process.env.DB_PING_MAX_ATTEMPTS) || 5,
            baseDelayMs: Number(process.env.DB_PING_BASE_MS)      || 500,
            onAttempt: ({ attempt, err }) =>
                console.log(`      DB    : ping attempt ${attempt} failed: ${err.code || err.message}`),
        });
        const label = attempts > 1 ? ` (after ${attempts} attempts)` : '';
        console.log(`      DB    : ${dbName}@${dbHost}:${dbPort} connected${label}`);
    } catch (err) {
        console.log(`      DB    : ${dbName}@${dbHost}:${dbPort} FAILED — ${err.code || 'ERROR'}: ${err.message}`);
        console.log(`              → Check api/.env (DB_HOST/PORT/DATABASE/USERNAME/PASSWORD).`);
        console.log(`              → Is PostgreSQL running and does database "${dbName}" exist?`);
        // Intentionally do NOT exit — /api/v1/ping stays alive for health probes.
    }
    console.log('');
});

module.exports = app;
module.exports._server = server;
