'use strict';

/* ─────────────────────────────────────────────────────────────
 * web/public/js/history.js — Change History detail + revert popup.
 *
 * Loaded only on /history (via the layout `pageScript` slot).
 *
 *  • Intercepts the per-row eye/view button ([data-row-view]) in the CAPTURE
 *    phase (so app.js's generic details modal doesn't also fire), fetches
 *    GET /history/:id, and fills #historyModal with:
 *      - the change meta (module, record, action, source, who, when, summary),
 *      - a field-by-field BEFORE → AFTER diff (changed fields highlighted),
 *      - a Compare table (this record across its history dates), and
 *      - a Revert button (shown only when the entry has a "before" snapshot).
 *
 *  • Revert arms #confirmRevertModal; confirming submits the hidden form
 *    POST /history/:id/revert (cloud-side revert; re-syncs to Tally next cycle).
 *
 * Defensive throughout: a missing element degrades to a no-op.
 * ─────────────────────────────────────────────────────────── */

(function () {
    function $(id) { return document.getElementById(id); }
    function show(el) { if (el) el.classList.remove('d-none'); }
    function hide(el) { if (el) el.classList.add('d-none'); }
    function setText(id, txt) {
        var el = $(id);
        if (el) el.textContent = (txt == null || txt === '') ? '—' : String(txt);
    }
    function esc(v) {
        if (v == null) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    var currentRevertId = null;

    function statusClass(s) {
        var v = String(s || '').toLowerCase();
        if (v.indexOf('delet') > -1) return 'pill-status--danger';
        if (v.indexOf('creat') > -1 || v.indexOf('sync') > -1) return 'pill-status--success';
        if (v.indexOf('revert') > -1) return 'pill-status--warning';
        if (v.indexOf('updat') > -1) return 'pill-status--info';
        return 'pill-status--muted';
    }

    function getModal(id) {
        var el = $(id);
        if (!el) return null;
        if (window.bootstrap && window.bootstrap.Modal) {
            return window.bootstrap.Modal.getOrCreateInstance(el);
        }
        return null;
    }

    /* Render one value for display — objects/arrays as compact JSON, else raw. */
    function fmtVal(v) {
        if (v == null || v === '') return '—';
        if (typeof v === 'object') {
            try { return JSON.stringify(v); } catch (e) { return String(v); }
        }
        return String(v);
    }

    /* Build the BEFORE → AFTER diff table body. Skips bookkeeping columns.
     * Rows whose value changed (per changed_fields, falling back to a compare)
     * get the .is-changed highlight. */
    function renderDiff(before, after, changedFields) {
        var body = $('h-diff-body');
        if (!body) return;
        body.innerHTML = '';

        var skip = { updated_at: 1, created_at: 1 };
        var changed = {};
        (changedFields || []).forEach(function (f) { changed[f] = 1; });

        var keys = {};
        if (before && typeof before === 'object') Object.keys(before).forEach(function (k) { keys[k] = 1; });
        if (after && typeof after === 'object') Object.keys(after).forEach(function (k) { keys[k] = 1; });
        var list = Object.keys(keys).filter(function (k) { return !skip[k]; }).sort();

        if (!list.length) {
            body.innerHTML = '<tr><td colspan="3" class="text-muted text-center py-3">No field-level data.</td></tr>';
            return;
        }

        list.forEach(function (k) {
            var bv = before ? before[k] : undefined;
            var av = after ? after[k] : undefined;
            var isChanged = changed[k] || (fmtVal(bv) !== fmtVal(av));
            var tr = document.createElement('tr');
            if (isChanged) tr.className = 'is-changed';
            tr.innerHTML =
                '<td>' + esc(k) + '</td>' +
                '<td class="diff-old">' + esc(fmtVal(bv)) + '</td>' +
                '<td class="diff-new">' + esc(fmtVal(av)) + '</td>';
            body.appendChild(tr);
        });
    }

    /* Build the Compare table: rows = fields, columns = each snapshot date.
     * A cell that differs from the previous snapshot is highlighted. */
    function renderCompare(compare) {
        var head = $('h-compare-head');
        var body = $('h-compare-body');
        var empty = $('h-compare-empty');
        var wrap = $('h-compare-wrap');
        if (!head || !body) return;
        head.innerHTML = '';
        body.innerHTML = '';

        var snaps = (compare && Array.isArray(compare.snapshots)) ? compare.snapshots : [];
        var fields = (compare && Array.isArray(compare.fields)) ? compare.fields : [];

        if (snaps.length < 2 || !fields.length) {
            if (wrap) hide(wrap);
            if (empty) show(empty);
            return;
        }
        if (wrap) show(wrap);
        if (empty) hide(empty);

        // Header: Field | snapshot columns.
        var hrow = '<th>Field</th>';
        snaps.forEach(function (s) {
            var lbl = (s.action || '') + (s.when ? (' · ' + s.when) : '');
            hrow += '<th>' + esc(lbl) + '</th>';
        });
        head.innerHTML = hrow;

        // One row per field; highlight a cell that changed vs the column before.
        fields.forEach(function (f) {
            var row = '<td>' + esc(f) + '</td>';
            var prev;
            snaps.forEach(function (s, i) {
                var val = (s.values && Object.prototype.hasOwnProperty.call(s.values, f)) ? s.values[f] : undefined;
                var disp = fmtVal(val);
                var cls = (i > 0 && disp !== prev) ? ' class="cell-changed"' : '';
                row += '<td' + cls + '>' + esc(disp) + '</td>';
                prev = disp;
            });
            var tr = document.createElement('tr');
            tr.innerHTML = row;
            body.appendChild(tr);
        });
    }

    function fill(d) {
        setText('historyId', d.id ? ('#' + d.id) : '');
        setText('h-module', d.module);

        var rec = d.record_label || '';
        var bits = [];
        if (d.record_type) bits.push(d.record_type);
        if (d.record_id !== '' && d.record_id != null) bits.push('#' + d.record_id);
        var recLine = rec;
        if (bits.length) recLine = rec ? (rec + ' (' + bits.join(' ') + ')') : bits.join(' ');
        setText('h-record', recLine);

        var act = $('h-action');
        if (act) { act.textContent = d.action || '—'; act.className = 'pill-status ' + statusClass(d.action_raw || d.action); }

        setText('h-source', d.source);
        setText('h-who', d.who);
        setText('h-when', d.created_at);
        setText('h-summary', d.summary);

        renderDiff(d.before, d.after, d.changed_fields);
        renderCompare(d.compare);

        // Revert button — only when this entry has a before snapshot.
        var revBtn = $('historyRevertBtn');
        if (revBtn) {
            if (d.revertable && d.id) {
                currentRevertId = d.id;
                show(revBtn);
            } else {
                currentRevertId = null;
                hide(revBtn);
            }
        }
    }

    function openDetail(id) {
        var modal = getModal('historyModal');
        if (!modal) return;
        var loading = $('historyLoading');
        var errBox  = $('historyError');
        var content = $('historyContent');

        show(loading); hide(errBox); hide(content);
        hide($('historyRevertBtn'));
        currentRevertId = null;
        modal.show();

        fetch('/history/' + encodeURIComponent(id), {
            headers: { Accept: 'application/json' }, credentials: 'same-origin',
        })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                hide(loading);
                if (j && j.ok && j.data) {
                    fill(j.data);
                    show(content);
                } else {
                    if (errBox) { errBox.textContent = 'Could not load this history entry.'; show(errBox); }
                }
            })
            .catch(function () {
                hide(loading);
                if (errBox) { errBox.textContent = 'Could not reach the server.'; show(errBox); }
            });
    }

    function armRevert() {
        if (!currentRevertId) return;
        var confirmModal = getModal('confirmRevertModal');
        if (confirmModal) confirmModal.show();
    }

    function doRevert() {
        if (!currentRevertId) return;
        var form = $('historyRevertForm');
        if (!form) return;
        form.action = '/history/' + encodeURIComponent(currentRevertId) + '/revert';
        form.submit();
    }

    function init() {
        // Capture phase + stopPropagation so app.js's generic details modal does
        // NOT also open for these rows.
        document.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('[data-row-view]') : null;
            if (!btn) return;
            if (!btn.closest('#history-table')) return;
            var id = btn.getAttribute('data-record-id');
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            openDetail(id);
        }, true);

        var revBtn = $('historyRevertBtn');
        if (revBtn) revBtn.addEventListener('click', function (e) { e.preventDefault(); armRevert(); });

        var confirmBtn = $('confirmRevertBtn');
        if (confirmBtn) confirmBtn.addEventListener('click', function (e) { e.preventDefault(); confirmBtn.disabled = true; doRevert(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
