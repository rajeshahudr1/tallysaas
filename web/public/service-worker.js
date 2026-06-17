'use strict';

/* ─────────────────────────────────────────────────────────────
 * service-worker.js — PWA service worker (spec §9).
 *
 * Strategy:
 *   • install  → pre-cache the core same-origin static shell.
 *   • activate → drop old cache versions.
 *   • fetch:
 *       - navigations (HTML) → network-first, fall back to cache,
 *         then to the cached "/" shell so the app still opens offline.
 *       - same-origin GET static → cache-first (and lazily fill cache).
 *       - cross-origin (CDNs) → passthrough to the network (don't cache
 *         third-party responses in this demo).
 *
 * Bump CACHE_VERSION to invalidate the old precache on deploy.
 * ─────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'tallysync-v4';

// Core shell assets worth precaching (all same-origin / CDN-independent).
const PRECACHE = [
    '/',
    '/customers',
    '/customers/add',
    '/css/theme.css',
    '/js/app.js',
    '/js/dashboard.js',
    '/img/logo.svg',
    '/img/avatar.svg',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
    '/manifest.webmanifest',
];

/* ── install ─────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) =>
            // addAll is atomic; one 404 fails the whole install, so cache
            // each entry individually and ignore the misses.
            Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
        ).then(() => self.skipWaiting())
    );
});

/* ── activate (clean old caches) ─────────────────────────────── */
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

/* ── fetch ───────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle GET; let the browser deal with the rest.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;

    // Navigations (page loads) → network-first with offline fallback.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    cachePut(req, res.clone());
                    return res;
                })
                .catch(() =>
                    caches.match(req).then((hit) => hit || caches.match('/'))
                )
        );
        return;
    }

    // Same-origin CSS / JS → NETWORK-FIRST so code/style updates always reach
    // the browser when online (cache-first here was serving stale theme.css /
    // app.js after edits — the cause of "my fixes don't show up"). Falls back
    // to cache only when offline.
    if (sameOrigin && /\.(css|js)(\?|$)/i.test(url.pathname)) {
        event.respondWith(
            fetch(req)
                .then((res) => { cachePut(req, res.clone()); return res; })
                .catch(() => caches.match(req))
        );
        return;
    }

    // Same-origin STATIC assets (images / icons / fonts / manifest) → cache-first.
    const STATIC_RE = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|webmanifest)(\?|$)/i;
    if (sameOrigin && STATIC_RE.test(url.pathname)) {
        event.respondWith(
            caches.match(req).then((hit) => {
                if (hit) return hit;
                return fetch(req).then((res) => {
                    cachePut(req, res.clone());
                    return res;
                });
            })
        );
        return;
    }

    // Same-origin DYNAMIC data (e.g. /sync-dashboard.json poller, *.json, any
    // non-asset GET) → NETWORK-FIRST and NEVER cached, so live data (sync status,
    // counts, heartbeat) is always fresh online. cache-first here was serving a
    // STALE cached /sync-dashboard.json so the 15s poller kept re-painting a fake
    // "Connected" / old 204·28 over the fresh server render. Offline → cache fallback.
    if (sameOrigin) {
        event.respondWith(
            fetch(req).catch(() => caches.match(req))
        );
        return;
    }

    // Cross-origin (CDNs) → straight to network.
    // (No respondWith → default browser handling.)
});

/* Store a response in the active cache (best-effort; only ok 200s). */
function cachePut(req, res) {
    if (!res || res.status !== 200 || res.type === 'opaque') return;
    caches.open(CACHE_VERSION).then((cache) => cache.put(req, res)).catch(() => {});
}
