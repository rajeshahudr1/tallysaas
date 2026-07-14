'use strict';

/**
 * api/Helpers/logger.js
 *
 * Lightweight, dependency-free file logger with DATE-WISE DAILY rotation so
 * every error is persisted and reviewable after the fact (stdout is lost on
 * restart). Writes under api/logs/:
 *
 *   logs/app-YYYY-MM-DD.log     — everything (INFO / WARN / ERROR / FATAL)
 *   logs/error-YYYY-MM-DD.log   — ERROR + FATAL only, so "what broke today" is
 *                                 one file per day, easy to open and grep.
 *   logs/sync-YYYY-MM-DD.log    — Tally⇄cloud SYNC activity only (per-module
 *                                 import breakdowns + sync failures), isolated so
 *                                 a sync issue is found directly in one file.
 *
 * A NEW pair of files is used automatically each calendar day (the filename
 * carries the local date), so there is nothing to schedule — the "rotation" is
 * just the date in the name.
 *
 * Coverage (the "every function logs its error" requirement):
 *   1. patchConsole() tees EVERY existing console.error / console.warn in the
 *      codebase (183+ call sites in the controllers' try/catch blocks) into the
 *      daily file too — no need to touch each function.
 *   2. The global errorHandler middleware calls logger.requestError() with full
 *      request context for anything thrown/next(err)-ed.
 *   3. installProcessHandlers() captures uncaughtException / unhandledRejection.
 *
 * Writes are synchronous appends: at this app's scale that keeps log ordering
 * correct and guarantees the line is on disk even if the process crashes right
 * after (which is exactly when you most want the log).
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* best-effort */ }

// Local YYYY-MM-DD (NOT UTC) so the file's date matches the operator's day.
function ymd(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

// Full local timestamp for each line.
function stamp() {
    const x = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${ymd(x)} ${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
}

// Render mixed args (strings kept as-is, objects/errors inspected with a stack).
function fmt(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        return util.inspect(a, { depth: 5, breakLength: 120 });
    }).join(' ');
}

function append(file, line) {
    try { fs.appendFileSync(path.join(LOG_DIR, file), line + '\n'); } catch (_) { /* never throw from logging */ }
}

// Core: write one line to today's app-*.log, and also error-*.log for ERROR/FATAL.
function emit(level, args, meta) {
    const date = ymd();
    const head = `[${stamp()}] [${level}]` + (meta ? ` [${meta}]` : '');
    const line = `${head} ${fmt(args)}`;
    append(`app-${date}.log`, line);
    if (level === 'ERROR' || level === 'FATAL') append(`error-${date}.log`, line);
}

// DEDICATED SYNC channel → logs/sync-YYYY-MM-DD.log, so every Tally⇄cloud sync
// line (per-module import breakdowns + sync failures) lands in ONE file per day
// — open it directly when a sync issue appears, no grepping the busy app log.
// Errors ALSO tee into error-*.log so "what broke today" stays complete.
function emitSync(level, args, meta) {
    const date = ymd();
    const head = `[${stamp()}] [${level}]` + (meta ? ` [${meta}]` : '');
    const line = `${head} ${fmt(args)}`;
    append(`sync-${date}.log`, line);
    if (level === 'ERROR' || level === 'FATAL') append(`error-${date}.log`, line);
}

const logger = {
    info:  (...args) => emit('INFO',  args),
    warn:  (...args) => emit('WARN',  args),
    error: (...args) => emit('ERROR', args),
    fatal: (...args) => emit('FATAL', args),

    // Sync-only channel (→ logs/sync-*.log). Use for Tally⇄cloud sync activity.
    sync:      (...args) => emitSync('INFO',  args),
    syncWarn:  (...args) => emitSync('WARN',  args),
    syncError: (...args) => emitSync('ERROR', args),

    /**
     * Log a request-scoped error with FULL context (request id, method, url,
     * who, and the error's stack). Used by the global error handler so any
     * unhandled failure is traceable to the exact request that caused it.
     */
    requestError(req, err, note) {
        let meta = '';
        try {
            const rid  = req && req.requestId ? req.requestId.slice(0, 8) : '--------';
            const who  = (req && req.user)
                ? `user=${req.user.sub || req.user.id || '?'} role=${req.user.role_slug || '?'} lic=${req.user.license_id || '-'}`
                : (req && req.license ? `agent-lic=${req.license.id}` : 'anon');
            const co   = req && (req.companyId != null) ? ` company=${req.companyId}` : '';
            meta = `${rid} ${req ? req.method : ''} ${req ? (req.originalUrl || req.url) : ''} | ${who}${co}`;
        } catch (_) { /* ignore meta build errors */ }
        emit('ERROR', [note || 'Unhandled error:', err], meta);
    },
};

/**
 * Tee console.error / console.warn into the daily file so the 183 existing
 * `console.error(...)` calls in the controllers are ALL persisted, without
 * editing each call site. Original console output is preserved (dev still sees
 * it live). Idempotent — safe to call once at boot.
 */
let _patched = false;
function patchConsole() {
    if (_patched) return;
    _patched = true;
    const origErr  = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args) => { emit('ERROR', args); origErr(...args); };
    console.warn  = (...args) => { emit('WARN',  args); origWarn(...args); };
}

/** Catch process-level failures so even a crash leaves a dated log line. */
function installProcessHandlers() {
    process.on('uncaughtException', (err) => {
        emit('FATAL', ['uncaughtException:', err]);
    });
    process.on('unhandledRejection', (reason) => {
        emit('FATAL', ['unhandledRejection:', reason]);
    });
}

/** One-call boot init: patch console + install process handlers. */
function init() {
    patchConsole();
    installProcessHandlers();
    emit('INFO', [`logger initialised — daily files in ${LOG_DIR}`]);
}

module.exports = { logger, init, patchConsole, installProcessHandlers, LOG_DIR };
