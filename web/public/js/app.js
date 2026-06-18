'use strict';

/* ─────────────────────────────────────────────────────────────
 * app.js — site-wide UI behaviours (Phase 1, no backend).
 *
 * Wires:
 *   • Filter-card collapse chevron sync (aria-expanded ↔ rotation).
 *   • Table select-all → toggles every row checkbox in that table.
 *   • Generic checkbox-group select-all ([data-select-all-checks]).
 *   • Textarea char counters ([data-counter] → "n/max").
 *   • "Same as Shipping Address" → copy shipping → billing + disable.
 *   • PWA install: capture beforeinstallprompt, reveal the header
 *     "Install App" button, prompt on click.
 *   • Online/offline indicator in the header.
 *
 * Everything is defensively guarded so a page missing a given widget
 * never throws. Bootstrap handles the offcanvas sidebar drawer and tab
 * switching declaratively (data-bs-* attrs in the markup).
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        initSidebarGroups();
        initRowActions();
        initListControls();
        initExport();
        initSelectAll();
        initCheckGroups();
        initCharCounters();
        initSameAsShipping();
        initSyncButtons();
        initNotifications();
        initPwaInstall();
        initOfflineIndicator();
        // Bootstrap's collapse already toggles aria-expanded on the
        // filter-card header (it is the [data-bs-toggle] element), so the
        // chevron rotation is pure CSS. Nothing to wire here.
    }

    /* ── Sidebar group collapse / expand ──────────────────────────
     * Each labelled menu group has a [data-group] toggle button + a
     * [data-group-items] list. Clicking toggles the group; the state is
     * remembered per-group in localStorage so it sticks across pages.
     * ─────────────────────────────────────────────────────────── */
    function initSidebarGroups() {
        var KEY = 'tcs.sidebar.collapsed';
        var collapsed;
        try { collapsed = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
        catch (e) { collapsed = {}; }

        function apply(gid, isCollapsed) {
            document.querySelectorAll('[data-group="' + gid + '"]').forEach(function (btn) {
                btn.classList.toggle('is-collapsed', isCollapsed);
                btn.setAttribute('aria-expanded', String(!isCollapsed));
            });
            document.querySelectorAll('[data-group-items="' + gid + '"]').forEach(function (list) {
                list.classList.toggle('is-collapsed', isCollapsed);
            });
        }

        // Restore saved state on load.
        Object.keys(collapsed).forEach(function (gid) { if (collapsed[gid]) apply(gid, true); });

        document.querySelectorAll('.sidebar-section-toggle').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var gid = btn.getAttribute('data-group');
                var nowCollapsed = !btn.classList.contains('is-collapsed');
                apply(gid, nowCollapsed);
                collapsed[gid] = nowCollapsed;
                try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch (e) { /* ignore */ }
            });
        });
    }

    /* ── Row actions: custom View / Delete popups ─────────────────
     * Replaces browser confirm()/alert() with on-brand Bootstrap modals.
     *   • [data-row-view]   → fills + opens the details modal from its
     *                         data-record JSON (label/value pairs).
     *   • [data-row-delete] → opens the confirm modal; on confirm, POSTs to
     *                         {data-delete-url}/delete (route deletes + flashes).
     * Delegated from document so it also covers rows added after load.
     * ─────────────────────────────────────────────────────────── */
    function initRowActions() {
        var BS = window.bootstrap;
        var delEl  = document.getElementById('confirmDeleteModal');
        var viewEl = document.getElementById('viewRecordModal');
        var delModal  = (BS && delEl)  ? BS.Modal.getOrCreateInstance(delEl)  : null;
        var viewModal = (BS && viewEl) ? BS.Modal.getOrCreateInstance(viewEl) : null;
        var pendingUrl = null;

        document.addEventListener('click', function (e) {
            var del = e.target.closest('[data-row-delete]');
            if (del && delModal) {
                e.preventDefault();
                pendingUrl = del.getAttribute('data-delete-url');
                var label = del.getAttribute('data-delete-label') || 'this record';
                var txt = document.getElementById('confirmDeleteText');
                if (txt) {
                    txt.textContent = '';
                    txt.appendChild(document.createTextNode('You are about to delete '));
                    var strong = document.createElement('strong');
                    strong.textContent = label;
                    txt.appendChild(strong);
                    txt.appendChild(document.createTextNode('. This action cannot be undone.'));
                }
                delModal.show();
                return;
            }

            var view = e.target.closest('[data-row-view]');
            if (view && viewModal) {
                e.preventDefault();
                var rec = [];
                try { rec = JSON.parse(view.getAttribute('data-record') || '[]'); } catch (err) { rec = []; }
                var title = view.getAttribute('data-record-title') || 'Details';
                var titleEl = document.getElementById('viewRecordTitle');
                var body = document.getElementById('viewRecordBody');
                if (titleEl) titleEl.textContent = title;
                if (body) {
                    body.textContent = '';
                    rec.forEach(function (r) {
                        // A {group:'…'} entry renders a tab-wise section header.
                        if (r && r.group) {
                            var h = document.createElement('div');
                            h.className = 'record-detail-group';
                            h.textContent = r.group;
                            h.style.cssText = 'font-weight:600;margin:14px 0 6px;color:#2563eb;border-bottom:1px solid #e5e7eb;padding-bottom:4px;';
                            body.appendChild(h);
                            return;
                        }
                        var rowEl = document.createElement('div'); rowEl.className = 'record-detail-row';
                        var dt = document.createElement('dt'); dt.textContent = r.label;
                        var dd = document.createElement('dd'); dd.textContent = r.value;
                        rowEl.appendChild(dt); rowEl.appendChild(dd); body.appendChild(rowEl);
                    });
                }
                viewModal.show();
                return;
            }
        });

        var confirmBtn = document.getElementById('confirmDeleteBtn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', function () {
                if (!pendingUrl) return;
                confirmBtn.disabled = true;
                var form = document.createElement('form');
                form.method = 'POST';
                form.action = pendingUrl + '/delete';
                document.body.appendChild(form);
                form.submit();
            });
        }
    }

    /* ── List controls: per-page + Ctrl/Cmd+K search focus ────────
     * "Show N entries" reloads the list with ?per_page=N&page=1 (the
     * backend already honours per_page). Filters in the query string are
     * preserved by URL(). Ctrl/Cmd+K focuses the global search box.
     * ─────────────────────────────────────────────────────────── */
    function initListControls() {
        document.querySelectorAll('[data-perpage], .toolbar-show select').forEach(function (sel) {
            sel.addEventListener('change', function () {
                var u = new URL(window.location.href);
                u.searchParams.set('per_page', sel.value);
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });

        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
                var s = document.querySelector('.topbar-search-input');
                if (s) { e.preventDefault(); s.focus(); }
            }
        });

        // Toolbar "Sort By" select → map the chosen column label to a sortable
        // header's key (data-sort-key) and reload with ?sort=&order=.
        document.querySelectorAll('.toolbar-sort select').forEach(function (sel) {
            sel.addEventListener('change', function () {
                var label = (sel.options[sel.selectedIndex].text || '').trim().toLowerCase();
                var hit = Array.prototype.filter.call(
                    document.querySelectorAll('[data-sort-key]'),
                    function (a) { return a.textContent.trim().toLowerCase() === label; }
                )[0];
                if (!hit) return; // not a backend-sortable column
                var u = new URL(window.location.href);
                u.searchParams.set('sort', hit.getAttribute('data-sort-key'));
                if (!u.searchParams.get('order')) u.searchParams.set('order', 'asc');
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });

        // Sort-direction toggle button → flip ?order (only if a sort is active).
        document.querySelectorAll('.sort-dir-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var u = new URL(window.location.href);
                if (!u.searchParams.get('sort')) return;
                u.searchParams.set('order', u.searchParams.get('order') === 'asc' ? 'desc' : 'asc');
                u.searchParams.set('page', '1');
                window.location.assign(u.toString());
            });
        });
    }

    /* ── Export → CSV ─────────────────────────────────────────────
     * Any [data-export] button (the page-head "Export") downloads the
     * current page's data table as a CSV — client-side, no backend. Skips
     * the checkbox + actions columns and the "no records" row. A UTF-8 BOM
     * is prepended so Excel opens ₹/non-ASCII correctly.
     * ─────────────────────────────────────────────────────────── */
    function initExport() {
        document.querySelectorAll('[data-export]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                var table = document.querySelector('.data-table');
                if (!table) return;
                var csv = tableToCsv(table);
                if (csv == null) return;
                var name = (document.title.split('·')[0].trim() || 'export')
                    .replace(/\s+/g, '-').toLowerCase();
                downloadCsv(csv, name + '.csv');
            });
        });
    }

    function tableToCsv(table) {
        function skip(cell) {
            return cell.classList.contains('data-table-check') ||
                   cell.classList.contains('data-table-actions') ||
                   cell.classList.contains('data-table-actions-head');
        }
        function esc(v) {
            v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
            if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
            return v;
        }
        var lines = [];
        var head = table.querySelector('thead tr');
        if (head) {
            var hc = Array.prototype.filter.call(head.children, function (c) { return !skip(c); });
            lines.push(hc.map(function (c) { return esc(c.textContent); }).join(','));
        }
        Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
            if (tr.querySelector('.data-table-empty')) return;
            var cells = Array.prototype.filter.call(tr.children, function (c) { return !skip(c); });
            if (!cells.length) return;
            lines.push(cells.map(function (c) { return esc(c.textContent); }).join(','));
        });
        return lines.join('\r\n');
    }

    function downloadCsv(csv, filename) {
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* ── Table select-all ─────────────────────────────────────── */
    function initSelectAll() {
        document.querySelectorAll('[data-select-all]').forEach(function (master) {
            var tableId = master.getAttribute('data-select-all');
            master.addEventListener('change', function () {
                document
                    .querySelectorAll('[data-row-check="' + tableId + '"]')
                    .forEach(function (cb) { cb.checked = master.checked; });
            });

            // Keep the master in sync if a row checkbox is toggled.
            var rows = document.querySelectorAll('[data-row-check="' + tableId + '"]');
            rows.forEach(function (cb) {
                cb.addEventListener('change', function () {
                    var all = Array.prototype.every.call(rows, function (r) { return r.checked; });
                    var none = Array.prototype.every.call(rows, function (r) { return !r.checked; });
                    master.checked = all;
                    master.indeterminate = !all && !none;
                });
            });
        });
    }

    /* ── Generic checkbox-group select-all ────────────────────────
     * Markup contract (NOT tied to a table):
     *   master   <input type="checkbox" data-select-all-checks="<group>">
     *   members  <input type="checkbox" data-check-group="<group>">
     * Used by e.g. the Sales Person → Assigned Locations mapping grid.
     * ─────────────────────────────────────────────────────────── */
    function initCheckGroups() {
        document.querySelectorAll('[data-select-all-checks]').forEach(function (master) {
            var group = master.getAttribute('data-select-all-checks');
            var members = document.querySelectorAll('[data-check-group="' + group + '"]');
            if (!members.length) return;

            master.addEventListener('change', function () {
                members.forEach(function (cb) { cb.checked = master.checked; });
            });

            members.forEach(function (cb) {
                cb.addEventListener('change', function () {
                    var all  = Array.prototype.every.call(members, function (m) { return m.checked; });
                    var none = Array.prototype.every.call(members, function (m) { return !m.checked; });
                    master.checked = all;
                    master.indeterminate = !all && !none;
                });
            });
        });
    }

    /* ── Tally sync buttons (demo spinner) ────────────────────────
     * Any [data-sync-btn] shows a "Syncing…" spinner, then a brief
     * "Synced" tick, then restores. Visual only (no backend in Phase 1).
     * ─────────────────────────────────────────────────────────── */
    function initSyncButtons() {
        document.querySelectorAll('[data-sync-btn], .btn-sync-now, #sync-now, #sync-retry').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (btn.classList.contains('is-syncing')) return;
                var original = btn.innerHTML;
                btn.classList.add('is-syncing');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Syncing…';
                setTimeout(function () {
                    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Synced';
                    setTimeout(function () {
                        btn.innerHTML = original;
                        btn.classList.remove('is-syncing');
                        btn.disabled = false;
                    }, 1200);
                }, 1400);
            });
        });
    }

    /* ── Notification bell read-tracking ──────────────────────────
     * Per-item read state for the header bell (header.ejs):
     *   • Clicking a [data-notif-key] item → POST /notifications/read {key};
     *     on success set the live .topbar-badge to the returned `unread`
     *     (remove it at 0) + mark that item read. The item's normal navigation
     *     is NOT blocked — we fire the fetch and let the real link proceed (only
     *     preventDefault for placeholder "#"/empty hrefs, e.g. agent-update).
     *   • Clicking #notif-mark-all → preventDefault + POST /notifications/read-all
     *     → badge to 0 (removed) + every dropdown item marked read.
     * Everything is null-guarded so a page without the bell is a no-op. Bodies
     * are form-encoded (matches the web's express.urlencoded parser). */
    function initNotifications() {
        // Locate the bell's badge fresh each time (it may have been removed).
        function badgeEl() { return document.querySelector('.topbar-badge'); }

        // Set the visible unread number. 0 (or null/blank) removes the badge.
        function setBadge(n) {
            var num = Number(n);
            var el = badgeEl();
            if (!Number.isFinite(num) || num <= 0) {
                if (el && el.parentNode) el.parentNode.removeChild(el);
                return;
            }
            if (el) { el.textContent = String(num); return; }
            // No badge present but count > 0: recreate it inside the bell button.
            var btn = document.querySelector('.topbar-icon-btn');
            if (!btn) return;
            var span = document.createElement('span');
            span.className = 'topbar-badge';
            span.textContent = String(num);
            btn.appendChild(span);
        }

        // Flip an item's read classes.
        function markItemRead(item) {
            if (!item) return;
            item.classList.remove('is-unread');
            item.classList.add('is-read');
        }

        // POST a form-encoded body and resolve the parsed JSON (or null).
        // keepalive:true so the request still completes when the click also
        // navigates the page away (failed-sync items link to /sync-logs) — the
        // body is tiny, well under the keepalive size cap, so the mark-read
        // actually lands and persists across the reload.
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
                keepalive: true,
                body: body,
            }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        }

        // Per-item click (delegated). Fire the mark-read, DON'T block real nav.
        document.addEventListener('click', function (e) {
            var item = e.target.closest('[data-notif-key]');
            if (!item) return;
            var key = item.getAttribute('data-notif-key');
            if (!key) return;
            // Already read → nothing to do (idempotent server-side anyway).
            if (item.classList.contains('is-read')) return;

            // If the link has no real destination (placeholder "#"/empty — e.g.
            // the agent-update entry), keep the dropdown usable by preventing the
            // jump; otherwise let the browser navigate after we fire the fetch.
            var href = item.getAttribute('href') || '';
            if (href === '' || href.charAt(0) === '#') e.preventDefault();

            postForm('/notifications/read', { key: key }).then(function (j) {
                if (j && j.ok) {
                    markItemRead(item);
                    if (j.unread != null) setBadge(j.unread);
                }
            });
        });

        // "Mark all read" → zero the badge + mark every dropdown item read.
        var markAll = document.getElementById('notif-mark-all');
        if (markAll) {
            markAll.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                postForm('/notifications/read-all', {}).then(function (j) {
                    if (j && j.ok) {
                        setBadge(0);
                        document.querySelectorAll('[data-notif-key]').forEach(markItemRead);
                        // Hide itself — there is nothing left to mark.
                        markAll.style.display = 'none';
                    }
                });
            });
        }
    }

    /* ── Char counters ────────────────────────────────────────────
     * Markup contract: a <textarea data-counter="<targetId>" maxlength="300">
     * paired with <span id="<targetId>">0/300</span> (or any element whose
     * text we overwrite). We read maxlength for the cap.
     * ─────────────────────────────────────────────────────────── */
    function initCharCounters() {
        document.querySelectorAll('[data-counter]').forEach(function (field) {
            var targetId = field.getAttribute('data-counter');
            var out = document.getElementById(targetId);
            if (!out) return;
            var max = parseInt(field.getAttribute('maxlength'), 10) || 300;
            var update = function () { out.textContent = field.value.length + '/' + max; };
            field.addEventListener('input', update);
            update();
        });
    }

    /* ── "Same as Shipping Address" ───────────────────────────────
     * Markup contract:
     *   checkbox  [data-same-as-shipping]  with
     *     data-source="<shippingTextareaId>" data-target="<billingTextareaId>"
     * When checked: copy source → target, mirror future edits, disable target.
     * ─────────────────────────────────────────────────────────── */
    function initSameAsShipping() {
        document.querySelectorAll('[data-same-as-shipping]').forEach(function (box) {
            var source = document.getElementById(box.getAttribute('data-source'));
            var target = document.getElementById(box.getAttribute('data-target'));
            if (!source || !target) return;

            var mirror = function () { target.value = source.value; fireCounter(target); };

            var apply = function () {
                if (box.checked) {
                    mirror();
                    target.setAttribute('disabled', 'disabled');
                    source.addEventListener('input', mirror);
                } else {
                    target.removeAttribute('disabled');
                    source.removeEventListener('input', mirror);
                }
            };
            box.addEventListener('change', apply);
            apply();
        });
    }

    // Re-run a textarea's counter after a programmatic value change.
    function fireCounter(el) {
        if (el.hasAttribute('data-counter')) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /* ── PWA install prompt ───────────────────────────────────── */
    function initPwaInstall() {
        var deferred = null;
        var btn = document.getElementById('installAppBtn');

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            deferred = e;
            if (btn) btn.hidden = false;
        });

        if (btn) {
            btn.addEventListener('click', function () {
                if (!deferred) return;
                deferred.prompt();
                deferred.userChoice.finally(function () {
                    deferred = null;
                    btn.hidden = true;
                });
            });
        }

        window.addEventListener('appinstalled', function () {
            if (btn) btn.hidden = true;
            deferred = null;
        });
    }

    /* ── Online / offline indicator ───────────────────────────── */
    function initOfflineIndicator() {
        var dot = document.getElementById('offlineIndicator');
        var sync = function () {
            var offline = navigator.onLine === false;
            document.body.classList.toggle('is-offline', offline);
            if (dot) dot.hidden = !offline;
        };
        window.addEventListener('online', sync);
        window.addEventListener('offline', sync);
        sync();
    }

    /* ── Action loaders ───────────────────────────────────────────
     * Immediate feedback on every action: a Bootstrap spinner + disabled
     * trigger on form submits (create/update/delete/import/filter/search)
     * and on navigating action buttons/links (export, "Add new", or any
     * [data-loader]). Server-rendered forms navigate away; download/in-page
     * actions auto-restore after a moment. Opt out with data-no-loader. */
    function _spin(el) {
        if (!el || el.dataset._busy) return;
        el.dataset._busy = '1';
        el.dataset._html = el.innerHTML;
        el.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>'
            + (el.dataset.loadingText || 'Please wait…');
        if (el.tagName === 'BUTTON') el.disabled = true;
        el.classList.add('is-loading');
    }
    function _unspin(el) {
        if (!el || !el.dataset._busy) return;
        if (el.dataset._html != null) el.innerHTML = el.dataset._html;
        el.disabled = false;
        el.classList.remove('is-loading');
        delete el.dataset._busy; delete el.dataset._html;
    }
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM' || form.dataset.noLoader != null) return;
        if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;
        var btn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (!btn && document.activeElement && document.activeElement.type === 'submit') btn = document.activeElement;
        _spin(btn);
    }, true);
    document.addEventListener('click', function (e) {
        var el = e.target.closest('a.btn, button[data-loader], a[data-loader]');
        if (!el || el.matches('[data-bs-toggle], [data-bs-dismiss]')) return;
        if (el.tagName === 'A') {
            var href = el.getAttribute('href') || '';
            if ((href === '' || href.charAt(0) === '#') && el.dataset.loader == null) return;
            if (el.target === '_blank' && el.dataset.loader == null) return;
        }
        _spin(el);
        setTimeout(function () { _unspin(el); }, parseInt(el.dataset.loaderMs, 10) || 2500);
    });
})();
