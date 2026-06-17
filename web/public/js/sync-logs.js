'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/public/js/sync-logs.js — Sync Logs detail popup.
 *
 * Loaded only on /sync-logs (via the layout `pageScript` slot).
 *
 *  • Intercepts the per-row eye/view button ([data-row-view]) in the CAPTURE
 *    phase so app.js's generic details modal doesn't also fire, fetches
 *    GET /sync-logs/:id, and fills + shows the richer #syncLogModal (module,
 *    record, direction, status + friendly cause/fix, message, both timestamps,
 *    and the raw request/response XML in collapsible <pre> blocks).
 *
 *  • Wires the page-head "Retry Failed" (#logs-retry) button to POST
 *    /sync-retry (re-queues this company's failed records).
 *
 * Defensive throughout: a missing element degrades to a no-op.
 * ─────────────────────────────────────────────────────────── */

(function () {
    function $(id) { return document.getElementById(id); }

    function statusClass(s) {
        var v = String(s || '').toLowerCase();
        if (v.indexOf('fail') > -1) return 'pill-status--danger';
        if (v.indexOf('creat') > -1 || v.indexOf('sync') > -1) return 'pill-status--success';
        if (v.indexOf('pending') > -1) return 'pill-status--warning';
        if (v.indexOf('sent') > -1) return 'pill-status--info';
        return 'pill-status--muted';
    }

    function getModal() {
        var el = $('syncLogModal');
        if (!el) return null;
        if (window.bootstrap && window.bootstrap.Modal) {
            return window.bootstrap.Modal.getOrCreateInstance(el);
        }
        return null;
    }

    function show(el) { if (el) el.classList.remove('d-none'); }
    function hide(el) { if (el) el.classList.add('d-none'); }

    function setText(id, txt) { var el = $(id); if (el) el.textContent = (txt == null || txt === '') ? '—' : String(txt); }

    function fill(d) {
        setText('syncLogId', d.id ? ('#' + d.id) : '');
        setText('sl-module', d.module);

        var rec = d.record_name || '';
        var bits = [];
        if (d.record_type) bits.push(d.record_type);
        if (d.record_id !== '' && d.record_id != null) bits.push('#' + d.record_id);
        var recLine = rec;
        if (bits.length) recLine = rec ? (rec + ' (' + bits.join(' ') + ')') : bits.join(' ');
        setText('sl-record', recLine);

        setText('sl-direction', d.direction);

        var st = $('sl-status');
        if (st) { st.textContent = d.status || '—'; st.className = 'pill-status ' + statusClass(d.status_raw || d.status); }

        setText('sl-cause', d.reason);
        setText('sl-fix', d.fix);
        setText('sl-message', d.message);
        setText('sl-retries', d.retry_count);
        setText('sl-created', d.created_at);
        setText('sl-synced', d.synced_at);

        var req = $('sl-request');  if (req) req.textContent = d.request_xml || '(none)';
        var res = $('sl-response'); if (res) res.textContent = d.response_xml || '(none)';
    }

    function openDetail(id) {
        var modal = getModal();
        if (!modal) return;
        var loading = $('syncLogLoading');
        var errBox  = $('syncLogError');
        var content = $('syncLogContent');

        show(loading); hide(errBox); hide(content);
        modal.show();

        fetch('/sync-logs/' + encodeURIComponent(id), {
            headers: { Accept: 'application/json' }, credentials: 'same-origin',
        })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                hide(loading);
                if (j && j.ok && j.data) {
                    fill(j.data);
                    show(content);
                } else {
                    if (errBox) { errBox.textContent = 'Could not load this log.'; show(errBox); }
                }
            })
            .catch(function () {
                hide(loading);
                if (errBox) { errBox.textContent = 'Could not reach the server.'; show(errBox); }
            });
    }

    function init() {
        // Capture phase + stopPropagation so app.js's bubble-phase generic
        // details modal does NOT also open for these rows.
        document.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('[data-row-view]') : null;
            if (!btn) return;
            // Only hijack rows inside the sync-logs table.
            if (!btn.closest('#sync-logs-table')) return;
            var id = btn.getAttribute('data-record-id');
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            openDetail(id);
        }, true);

        // Page-head "Retry Failed" → POST /sync-retry.
        var retry = $('logs-retry');
        if (retry) {
            retry.addEventListener('click', function (e) {
                e.preventDefault();
                retry.disabled = true;
                var f = document.createElement('form');
                f.method = 'POST';
                f.action = '/sync-retry';
                document.body.appendChild(f);
                f.submit();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
