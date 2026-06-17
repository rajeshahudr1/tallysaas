'use strict';

/* ─────────────────────────────────────────────────────────────
 * rbac.js — UNIFIED Roles & Permissions page interactions.
 *
 * Loaded only on /roles (via pageScript). Drives the role chips +
 * permission matrix on views/roles/index.ejs, all backed by the real
 * /account/roles API (the server renders the selected role; this wires
 * the client behaviour):
 *
 *   • Role chip selection → navigate to ?role=<id> so the server re-renders
 *     the matrix scoped to THAT role's entitlements + read-only state. (The
 *     #rbacData island carries every role's granted-slug set so the active
 *     label/chips stay in sync without a flash.)
 *   • THREE select-all levels on the matrix:
 *       – per-COLUMN  (header checkbox  → all modules for one action)
 *       – per-ROW     (module checkbox  → all actions of one module)
 *       – GLOBAL      (#rbac-select-all → every checkbox in the matrix)
 *     Header/row/global masters reflect the current state (indeterminate).
 *   • Add Role  → opens the #addRoleModal (POST /roles).
 *   • Rename    → opens the #renameRoleModal pre-filled (POST /roles/:id).
 *   • Save Permissions → gathers the checked <module>.<action> slugs and
 *     POSTs them to /roles/:id/permissions.
 *
 * Dependency-free (plain DOM); Bootstrap is used only for the modals when
 * present. Markup contract lives in views/roles/index.ejs.
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        wireRoleChips();
        wireAddRole();
        wireRenameRole();
        wireMatrix();
        wireSave();
    }

    /* ── Role chip selection → reload with ?role=<id> ───────────── */
    function wireRoleChips() {
        document.querySelectorAll('[name="rbac-role"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                var id = radio.value;
                if (!id) return;
                var url = new URL(window.location.href);
                url.searchParams.set('role', id);
                window.location.assign(url.toString());
            });
        });
    }

    /* ── Add Role → open the modal ─────────────────────────────── */
    function wireAddRole() {
        var btn = document.getElementById('rbac-add');
        var modalEl = document.getElementById('addRoleModal');
        if (!btn || !modalEl) return;
        btn.addEventListener('click', function () {
            showModal(modalEl, '#add-role-name');
        });
    }

    /* ── Rename → open the modal pre-filled, point the form at the role ── */
    function wireRenameRole() {
        var btn = document.getElementById('rbac-rename');
        var modalEl = document.getElementById('renameRoleModal');
        var form = document.getElementById('renameRoleForm');
        var input = document.getElementById('rename-role-name');
        if (!btn || !modalEl || !form || !input) return;
        btn.addEventListener('click', function () {
            if (btn.disabled) return;
            var id = btn.getAttribute('data-role-id');
            var name = btn.getAttribute('data-role-name') || '';
            form.action = '/roles/' + id;
            input.value = name;
            showModal(modalEl, '#rename-role-name');
        });
    }

    /* ── Permission matrix: column / row / global select-all ────── */
    function wireMatrix() {
        var matrix = document.getElementById('rbacMatrix');
        if (!matrix) return;
        var editable = matrix.getAttribute('data-editable') === '1';
        if (!editable) return;   // read-only role: no toggles

        var cellSel = 'input[data-module]';

        // Per-COLUMN (one action across every module).
        matrix.querySelectorAll('input[data-col-action]').forEach(function (master) {
            var act = master.getAttribute('data-col-action');
            master.addEventListener('change', function () {
                matrix.querySelectorAll('input[data-action="' + cssEsc(act) + '"]').forEach(function (cb) {
                    cb.checked = master.checked;
                });
                refreshMasters(matrix);
            });
        });

        // Per-ROW (every action of one module).
        matrix.querySelectorAll('[data-row-toggle]').forEach(function (rowCb) {
            rowCb.addEventListener('change', function () {
                var row = rowCb.closest('tr');
                if (!row) return;
                row.querySelectorAll(cellSel).forEach(function (cb) { cb.checked = rowCb.checked; });
                refreshMasters(matrix);
            });
        });

        // GLOBAL (every checkbox in the matrix).
        var global = document.getElementById('rbac-select-all');
        if (global) {
            global.addEventListener('change', function () {
                matrix.querySelectorAll(cellSel).forEach(function (cb) { cb.checked = global.checked; });
                refreshMasters(matrix);
            });
        }

        // Keep masters in sync when an individual cell changes.
        matrix.querySelectorAll(cellSel).forEach(function (cb) {
            cb.addEventListener('change', function () { refreshMasters(matrix); });
        });

        refreshMasters(matrix);
    }

    // Recompute the checked/indeterminate state of every master toggle from the
    // current cells (column headers, row toggles, the global toggle).
    function refreshMasters(matrix) {
        var cells = Array.prototype.slice.call(matrix.querySelectorAll('input[data-module]'));

        // Column headers.
        matrix.querySelectorAll('input[data-col-action]').forEach(function (master) {
            var act = master.getAttribute('data-col-action');
            var col = cells.filter(function (cb) { return cb.getAttribute('data-action') === act; });
            applyMaster(master, col);
        });

        // Row toggles.
        matrix.querySelectorAll('tbody tr').forEach(function (row) {
            var rowCb = row.querySelector('[data-row-toggle]');
            if (!rowCb) return;
            var rowCells = Array.prototype.slice.call(row.querySelectorAll('input[data-module]'));
            applyMaster(rowCb, rowCells);
        });

        // Global.
        var global = document.getElementById('rbac-select-all');
        if (global) applyMaster(global, cells);
    }

    function applyMaster(master, cells) {
        if (!cells.length) { master.checked = false; master.indeterminate = false; return; }
        var checked = cells.filter(function (cb) { return cb.checked; }).length;
        master.checked = checked === cells.length;
        master.indeterminate = checked > 0 && checked < cells.length;
    }

    /* ── Save Permissions → POST the checked slugs ─────────────── */
    function wireSave() {
        var saveBtn = document.getElementById('rbac-save');
        var matrix = document.getElementById('rbacMatrix');
        if (!saveBtn) return;
        saveBtn.addEventListener('click', function () {
            var radio = document.querySelector('[name="rbac-role"]:checked');
            if (!radio) { alert('Select a role first.'); return; }
            if (radio.getAttribute('data-editable') !== '1') {
                alert('This role is read-only and its permissions cannot be changed.');
                return;
            }
            var roleId = radio.getAttribute('data-role-id');
            if (!roleId) return;
            var slugs = [];
            if (matrix) {
                matrix.querySelectorAll('input[data-module]:checked').forEach(function (cb) {
                    slugs.push(cb.getAttribute('data-module') + '.' + cb.getAttribute('data-action'));
                });
            }
            var form = document.createElement('form');
            form.method = 'POST';
            form.action = '/roles/' + roleId + '/permissions';
            var inp = document.createElement('input');
            inp.type = 'hidden'; inp.name = 'slugs'; inp.value = JSON.stringify(slugs);
            form.appendChild(inp);
            document.body.appendChild(form);
            form.submit();
        });
    }

    /* ── Helpers ───────────────────────────────────────────────── */
    function showModal(modalEl, focusSel) {
        var BS = window.bootstrap;
        if (BS && BS.Modal) {
            var m = BS.Modal.getOrCreateInstance(modalEl);
            m.show();
            if (focusSel) {
                modalEl.addEventListener('shown.bs.modal', function once() {
                    var f = modalEl.querySelector(focusSel);
                    if (f) f.focus();
                    modalEl.removeEventListener('shown.bs.modal', once);
                });
            }
        } else {
            // Fallback: reveal the modal element directly.
            modalEl.classList.add('show');
            modalEl.style.display = 'block';
        }
    }

    // Minimal CSS.escape fallback for the action attribute (alnum + dash/underscore).
    function cssEsc(v) { return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
})();
