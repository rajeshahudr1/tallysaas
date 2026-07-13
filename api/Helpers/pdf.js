'use strict';

/**
 * api/Helpers/pdf.js
 *
 * Server-side HTML → PDF via a SHARED headless-Chromium (Puppeteer). One browser
 * is launched lazily and reused across requests (cheap: only a new tab per PDF);
 * it auto-relaunches if Chromium dies. The caller passes a fully-styled, clean,
 * data-only HTML string (no app chrome) — see Helpers/reportPdf.js.
 *
 * `--no-sandbox` is required when the API runs as root in a container/VPS.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Puppeteer dirs on a locked-down VPS ─────────────────────────────────────
// At launch, Puppeteer resolves its config via cosmiconfig, which stat()s
// ~/.config/puppeteer. When the API runs as a NON-root user but HOME still
// points at /root, that stat throws EACCES — and because it is SYNCHRONOUS it
// surfaces as an uncaughtException that takes the process down. Redirect the
// config + browser-cache dirs to an app-owned, writable folder BEFORE puppeteer
// is required, so nothing ever touches /root/.config. Each value is only set if
// the operator hasn't already provided one (pm2 env wins).
(function preparePuppeteerDirs() {
    try {
        const base  = process.env.PUPPETEER_HOME || path.join(__dirname, '..', '.puppeteer');
        const cfg   = path.join(base, 'config');
        const cache = process.env.PUPPETEER_CACHE_DIR || path.join(base, 'cache');
        for (const d of [base, cfg, cache]) fs.mkdirSync(d, { recursive: true });
        // Override HOME only if the current one isn't readable (don't disturb a
        // working root setup).
        let homeOk = false;
        try { fs.accessSync(process.env.HOME || os.homedir(), fs.constants.R_OK | fs.constants.X_OK); homeOk = true; } catch (_) { /* unreadable */ }
        if (!homeOk) process.env.HOME = base;
        process.env.XDG_CONFIG_HOME   = process.env.XDG_CONFIG_HOME   || cfg;
        process.env.XDG_CACHE_HOME    = process.env.XDG_CACHE_HOME    || path.join(base, 'xdg-cache');
        process.env.PUPPETEER_CACHE_DIR = cache;
    } catch (_) { /* best-effort — a real failure surfaces as a normal PDF error, not a crash */ }
})();

const puppeteer = require('puppeteer');

let _browser = null;
let _launching = null;

async function getBrowser() {
    if (_browser && _browser.isConnected()) return _browser;
    // Collapse concurrent first-calls onto a single launch.
    if (!_launching) {
        _launching = puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        }).then((b) => {
            _browser = b;
            _launching = null;
            b.on('disconnected', () => { _browser = null; });
            return b;
        }).catch((e) => { _launching = null; throw e; });
    }
    return _launching;
}

/**
 * Render an HTML string to a PDF Buffer.
 * @param {string} html  a complete, self-styled HTML document.
 * @param {object} [opts] { landscape?: bool, format?: 'A4' }.
 * @returns {Promise<Buffer>}
 */
async function htmlToPdf(html, opts = {}) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // 'load' (not networkidle0) — the report HTML is self-contained (no
        // external CSS/JS/images), so we needn't wait for network idle; 60s
        // headroom lets big reports (e.g. a few-hundred-row day book) render.
        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
        const out = await page.pdf({
            format: opts.format || 'A4',
            landscape: !!opts.landscape,
            printBackground: true,
            margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
            displayHeaderFooter: false,
        });
        // Newer Puppeteer returns a Uint8Array; Express's res.send needs a Buffer.
        return Buffer.isBuffer(out) ? out : Buffer.from(out);
    } finally {
        await page.close().catch(() => {});
    }
}

/** Best-effort shutdown (called on process exit if wired). */
async function closeBrowser() {
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
    }
}

module.exports = { htmlToPdf, closeBrowser };
