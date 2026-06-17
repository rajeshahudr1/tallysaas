'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/public/js/sync-dashboard.js — LIVE Sync Dashboard.
 *
 * Loaded only on /sync-dashboard (via the layout `pageScript` slot).
 *
 *  1) POLLS GET /sync-dashboard.json every 15s and updates the connection
 *     badge/dot, the Connection / Last Sync / Total Synced / Failed stat
 *     cards, and EACH module row's synced / pending / failed / progress IN
 *     PLACE via the DOM — NO full page reload. So the card flips to
 *     "Connected" (green) the moment the agent's heartbeat lands, without the
 *     user refreshing.
 *
 *  2) Wires the page-head "Retry Failed" (#sync-retry) and "Sync Now"
 *     (#sync-now) buttons to POST /sync-retry (the per-module Sync buttons +
 *     the banner/Sync-All buttons are real <form> POSTs already).
 *
 * Defensive: every lookup is null-guarded so a markup change degrades to a
 * no-op rather than throwing.
 * ─────────────────────────────────────────────────────────── */

(function () {
    var POLL_MS = 15000;
    var JSON_URL = '/sync-dashboard.json';

    function $(sel, root) { return (root || document).querySelector(sel); }

    function setText(el, txt) {
        if (el && txt != null && el.textContent !== String(txt)) el.textContent = String(txt);
    }

    /* Toggle the connection card + dot + text to the live state. */
    function applyConnection(connected, connText) {
        var card = $('#sync-conn-card');
        var dot  = $('#sync-conn-dot');
        var text = $('#sync-conn-text');
        var icon = card ? card.querySelector('.sync-conn-icon i') : null;

        if (card) {
            card.classList.toggle('is-connected', !!connected);
            card.classList.toggle('is-disconnected', !connected);
        }
        if (dot) {
            dot.classList.toggle('is-on', !!connected);
            dot.classList.toggle('is-off', !connected);
        }
        if (icon) {
            icon.classList.toggle('fa-plug-circle-check', !!connected);
            icon.classList.toggle('fa-plug-circle-xmark', !connected);
        }
        setText(text, connected ? 'Connected' : 'Disconnected');
        // Stat card mirrors the banner.
        setText($('#stat-connection'), connText || (connected ? 'Connected' : 'Disconnected'));

        // Not-connected alert (Requirement 3) — auto-hide once a heartbeat lands.
        var alert = $('#sync-disconnected-alert');
        if (alert) alert.hidden = !!connected;
        // Friendly-warn the manual buttons while disconnected (still allowed —
        // they queue and run on reconnect).
        var grid = $('#sync-modules-table');
        if (grid) grid.classList.toggle('is-disconnected-warn', !connected);
    }

    /* Update one module row from its data payload. */
    function applyModuleRow(m) {
        if (!m || !m.key) return;
        var tr = document.querySelector('tr[data-module-key="' + cssEscape(m.key) + '"]');
        if (!tr) return;
        var fmt = function (n) { return (Number(n) || 0).toLocaleString('en-IN'); };

        setText(tr.querySelector('.js-total'),   fmt(m.total));
        setText(tr.querySelector('.js-synced'),  fmt(m.synced));
        setText(tr.querySelector('.js-pending'), m.pending);
        setText(tr.querySelector('.js-failed'),  m.failed);
        setText(tr.querySelector('.js-pct'),     (m.pct != null ? m.pct : 0) + '%');
        setText(tr.querySelector('.js-lastsync'), m.last_sync || '—');

        var bar = tr.querySelector('.js-bar');
        if (bar) bar.style.width = (m.pct != null ? m.pct : 0) + '%';

        // Zero-count dimming (matches the EJS _cntCls helper).
        toggleZero(tr.querySelector('.js-pending'), m.pending);
        toggleZero(tr.querySelector('.js-failed'),  m.failed);
    }

    function toggleZero(el, n) {
        if (!el) return;
        el.classList.toggle('cnt-zero', !(Number(n) > 0));
    }

    /* Minimal CSS.escape fallback for the attribute selector (keys are
     * snake_case ids so escaping is rarely needed, but be safe). */
    function cssEscape(v) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(v);
        return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    /* Reflect the agent version + "update available" state live (Requirement 3),
     * WITHOUT clobbering a toggle the user is mid-change on (we only set the
     * switch from the server if the user hasn't touched it this session). */
    function applyVersion(d) {
        var installed = d.agent_version && d.agent_version !== '—' ? d.agent_version : '';
        var latest    = d.latest_version || '';
        var available = !!d.update_available;

        setText($('#sync-update-version'), installed ? ('v' + installed) : '—');

        // Banner "Update available[: vX]" badge.
        var badge = $('#sync-update-badge');
        if (badge) badge.style.display = available ? '' : 'none';
        var latestVerEls = document.querySelectorAll('#sync-latest-ver, .sync-update-latest-ver');
        for (var i = 0; i < latestVerEls.length; i++) setText(latestVerEls[i], latest);

        // Card "→ latest vX" hint.
        var latestWrap = $('#sync-update-latest');
        if (latestWrap) latestWrap.style.display = (available && latest) ? '' : 'none';

        var hint = $('#sync-update-hint');
        if (hint) {
            hint.textContent = available
                ? (autoUpdateOn() ? 'A newer version is available. It will update automatically.'
                                  : 'A newer version is available. Auto-update is off — use “Update now”.')
                : 'The agent is up to date.';
        }

        // The "Update now" button is only meaningful when an update is available.
        var btn = $('#sync-update-now');
        if (btn && !btn.dataset.busy) btn.disabled = !available;
    }

    function autoUpdateOn() {
        var t = $('#sync-auto-update-toggle');
        return t ? !!t.checked : true;
    }

    /* Reflect the per-license AUTO push/pull toggles live (Requirement 1),
     * WITHOUT clobbering a switch the user is mid-change on (dataset.busy is set
     * while a PATCH is in flight). Treat a missing flag as ON (the server
     * default). */
    function applyDirection(d) {
        [['push', '#sync-push-toggle'], ['pull', '#sync-pull-toggle']].forEach(function (pair) {
            var key = pair[0] === 'push' ? 'push_enabled' : 'pull_enabled';
            var t = $(pair[1]);
            if (!t || t.dataset.busy) return;
            if (d[key] === undefined) return;
            t.checked = d[key] !== false;
        });
    }

    function applyData(d) {
        if (!d) return;
        applyConnection(!!d.connected, d.connection);

        setText($('#sync-conn-agent'),     d.agent_version || '—');
        setText($('#sync-conn-company'),   d.company || '—');
        setText($('#sync-conn-heartbeat'), d.heartbeat || '—');
        setText($('#sync-conn-lastsync'),  d.last_sync || '—');

        setText($('#stat-last-sync'), d.last_sync || '—');
        setText($('#stat-total'),     d.total_synced_fmt != null ? d.total_synced_fmt : '0');
        setText($('#stat-failed'),    d.failed_fmt != null ? d.failed_fmt : '0');

        applyVersion(d);
        applyDirection(d);

        if (Array.isArray(d.modules)) d.modules.forEach(applyModuleRow);
    }

    function poll() {
        fetch(JSON_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.ok && j.data) applyData(j.data); })
            .catch(function () { /* transient — next tick retries */ });
    }

    /* The page-head Retry/Sync buttons aren't <form>s — POST them here. */
    function submitRetry() {
        var f = document.createElement('form');
        f.method = 'POST';
        f.action = '/sync-retry';
        document.body.appendChild(f);
        f.submit();
    }

    /* Lightweight transient toast (no dependency). Falls back to nothing if the
     * page has no toast host — the action still succeeded server-side. */
    function toast(msg, ok) {
        if (!msg) return;
        var host = $('#sync-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'sync-toast';
            host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:1080;' +
                'max-width:340px;padding:10px 14px;border-radius:8px;font-size:13px;' +
                'box-shadow:0 6px 24px rgba(0,0,0,.18);color:#fff;';
            document.body.appendChild(host);
        }
        host.style.background = ok ? '#16a34a' : '#dc2626';
        host.textContent = msg;
        host.style.display = 'block';
        clearTimeout(host._t);
        host._t = setTimeout(function () { host.style.display = 'none'; }, 4000);
    }

    /* POST a form-encoded body to a web route and return the parsed JSON. */
    function postForm(action, params) {
        var body = new URLSearchParams(params || {}).toString();
        return fetch(action, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            credentials: 'same-origin',
            body: body,
        }).then(function (r) { return r.ok ? r.json() : null; });
    }

    /* Auto-update ON/OFF switch → PATCH the per-license cloud toggle. */
    function wireAutoUpdateToggle() {
        var t = document.getElementById('sync-auto-update-toggle');
        if (!t) return;
        t.addEventListener('change', function () {
            var enabled = !!t.checked;
            t.disabled = true;
            postForm('/sync-auto-update', { enabled: enabled ? 'on' : '' })
                .then(function (j) {
                    if (j && j.ok) {
                        toast(j.msg || (enabled ? 'Auto-update turned ON.' : 'Auto-update turned OFF.'), true);
                    } else {
                        t.checked = !enabled;   // revert on failure
                        toast((j && j.msg) || 'Could not change auto-update.', false);
                    }
                })
                .catch(function () { t.checked = !enabled; toast('Could not reach the server.', false); })
                .then(function () { t.disabled = false; });
        });
    }

    /* "Update now" → enqueue a self_update command for the agent. */
    function wireUpdateNow() {
        var btn = document.getElementById('sync-update-now');
        if (!btn) return;
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            btn.dataset.busy = '1';
            btn.disabled = true;
            var original = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Requesting…';
            postForm('/sync-update-now', {})
                .then(function (j) {
                    toast((j && j.msg) || 'Update requested. The agent will update within a minute.', !!(j && j.ok));
                })
                .catch(function () { toast('Could not reach the server.', false); })
                .then(function () {
                    btn.innerHTML = original;
                    delete btn.dataset.busy;
                    // Leave it enabled so the user can retry; the next poll
                    // re-derives the disabled state from update_available.
                    btn.disabled = false;
                });
        });
    }

    /* Per-module 2-way buttons (Requirement 2) + Sync-All — intercept the
     * <form> submit, POST as XHR (so we can toast the api's msg + show a row
     * loader) and on success re-poll so the counts refresh. Falls back to a
     * normal submit if fetch is unavailable. The forms remain real POSTs so a
     * no-JS user still works. */
    function wireModuleSyncForms() {
        var forms = document.querySelectorAll('form.js-sync-form');
        for (var i = 0; i < forms.length; i++) wireOneSyncForm(forms[i]);
    }
    function wireOneSyncForm(form) {
        if (!form || form.dataset.wired) return;
        form.dataset.wired = '1';
        form.addEventListener('submit', function (e) {
            if (!window.fetch) return;   // no-JS / old browser → normal POST
            e.preventDefault();
            var btn = form.querySelector('button');
            if (btn && btn.dataset.busy) return;
            var original = btn ? btn.innerHTML : '';
            if (btn) {
                btn.dataset.busy = '1';
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            }
            postForm(form.getAttribute('action'), {})
                .then(function (j) {
                    var dir = form.getAttribute('data-direction') || 'push';
                    var def = dir === 'pull'
                        ? 'Queued an import from Tally.'
                        : 'Re-queued records for sync.';
                    toast((j && j.msg) || def, !!(j && j.ok));
                    poll();   // refresh the row counts
                })
                .catch(function () { toast('Could not reach the server.', false); })
                .then(function () {
                    if (btn) {
                        btn.innerHTML = original;
                        delete btn.dataset.busy;
                        btn.disabled = false;
                    }
                });
        });
    }

    /* Auto-sync DIRECTION switches (Requirement 1) → PATCH the per-license
     * push/pull toggle (proxied by POST /sync-direction). Optimistic with revert
     * on failure; dataset.busy guards the poller from clobbering mid-change. */
    function wireDirectionToggles() {
        ['sync-push-toggle', 'sync-pull-toggle'].forEach(function (id) {
            var t = document.getElementById(id);
            if (!t) return;
            t.addEventListener('change', function () {
                var dir = t.getAttribute('data-direction') || (id.indexOf('push') !== -1 ? 'push' : 'pull');
                var enabled = !!t.checked;
                var params = {};
                params[dir + '_enabled'] = enabled ? 'on' : '';
                t.dataset.busy = '1';
                t.disabled = true;
                postForm('/sync-direction', params)
                    .then(function (j) {
                        if (j && j.ok) {
                            var label = dir === 'push' ? 'Auto push' : 'Auto pull';
                            toast(j.msg || (label + (enabled ? ' turned ON.' : ' turned OFF.')), true);
                        } else {
                            t.checked = !enabled;   // revert on failure
                            toast((j && j.msg) || 'Could not change auto-sync direction.', false);
                        }
                    })
                    .catch(function () { t.checked = !enabled; toast('Could not reach the server.', false); })
                    .then(function () { delete t.dataset.busy; t.disabled = false; });
            });
        });
    }

    /* "Test Connection" (Requirement 3) → an immediate live re-check (poll). The
     * poller hides the alert + flips the banner green the moment a heartbeat is
     * seen; we toast the outcome so the click always gives feedback. */
    function wireTestConnection() {
        var btn = document.getElementById('sync-test-conn');
        if (!btn) return;
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (btn.dataset.busy) return;
            btn.dataset.busy = '1';
            btn.disabled = true;
            var original = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Checking…';
            fetch(JSON_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (j && j.ok && j.data) {
                        applyData(j.data);
                        toast(j.data.connected ? 'Agent is connected.' : 'Still not connected — start the agent and keep Tally open.', !!j.data.connected);
                    } else {
                        toast('Could not check the connection.', false);
                    }
                })
                .catch(function () { toast('Could not reach the server.', false); })
                .then(function () {
                    btn.innerHTML = original;
                    delete btn.dataset.busy;
                    btn.disabled = false;
                });
        });
    }

    function wireButtons() {
        ['sync-retry', 'sync-now'].forEach(function (id) {
            var btn = document.getElementById(id);
            if (!btn) return;
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                btn.disabled = true;
                submitRetry();
            });
        });
        wireAutoUpdateToggle();
        wireUpdateNow();
        wireModuleSyncForms();
        wireDirectionToggles();
        wireTestConnection();
    }

    function start() {
        wireButtons();
        // First poll soon so a stale "Disconnected" flips fast on load.
        setTimeout(poll, 2000);
        setInterval(poll, POLL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
