'use strict';

/* ─────────────────────────────────────────────────────────────
 * rbac.js — Roles & Permissions matrix interactions.
 *
 * Loaded only on /roles (via pageScript). Reads the per-role
 * permission map from a JSON island (#rbacData) and:
 *   • Switches the matrix checkboxes when a role chip is selected.
 *   • Wires per-column "select all" (header checkbox toggles that
 *     action across every module).
 *   • Updates the active-role label.
 *
 * Visual only — nothing is persisted in Phase 1.
 * Markup contract lives in views/roles/index.ejs.
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var island = document.getElementById('rbacData');
        var matrix = document.getElementById('rbacMatrix');
        if (!island || !matrix) return;

        var perms = {};
        try { perms = JSON.parse(island.textContent || '{}'); } catch (e) { perms = {}; }

        var label = document.getElementById('rbacActiveRole');

        // Apply a role's permission map to the matrix checkboxes.
        function applyRole(role) {
            var map = perms[role] || {};
            matrix.querySelectorAll('input[data-module]').forEach(function (cb) {
                var mod = cb.getAttribute('data-module');
                var act = cb.getAttribute('data-action');
                cb.checked = !!(map[mod] && map[mod][act]);
            });
            if (label) label.textContent = role;
        }

        // Role chip selection.
        document.querySelectorAll('[name="rbac-role"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                document.querySelectorAll('.rbac-role-chip').forEach(function (c) { c.classList.remove('is-active'); });
                var chip = radio.closest('.rbac-role-chip');
                if (chip) chip.classList.add('is-active');
                applyRole(radio.value);
            });
        });

        // Per-column "select all" (header checkbox by data-col-action).
        matrix.querySelectorAll('input[data-col-action]').forEach(function (master) {
            var act = master.getAttribute('data-col-action');
            master.addEventListener('change', function () {
                matrix.querySelectorAll('input[data-action="' + act + '"]').forEach(function (cb) {
                    cb.checked = master.checked;
                });
            });
        });

        // Seed from the initially-checked role chip.
        var checked = document.querySelector('[name="rbac-role"]:checked');
        if (checked) applyRole(checked.value);

        // Save Permissions → POST the selected role's checked (module.action)
        // slugs to /roles/:id/permissions (the server forwards to the api).
        var saveBtn = document.getElementById('rbac-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                var radio = document.querySelector('[name="rbac-role"]:checked');
                if (!radio) return;
                var roleId = radio.getAttribute('data-role-id');
                if (!roleId) { alert('This role cannot be edited here.'); return; }
                var slugs = [];
                matrix.querySelectorAll('input[data-module]:checked').forEach(function (cb) {
                    slugs.push(cb.getAttribute('data-module') + '.' + cb.getAttribute('data-action'));
                });
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
    }
})();
