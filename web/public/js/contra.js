'use strict';

/* ─────────────────────────────────────────────────────────────
 * contra.js — Create Contra Voucher: two searchable cash/bank-ledger
 * comboboxes (From/Cr, To/Dr) + the keyboard-first auto-advance flow.
 *
 * A Contra has no items grid, so this is a small copy of the combobox
 * machinery in delivery-note.js (registerPopup/makeCombobox), not a shared
 * import — same pattern the other voucher screens each keep locally.
 *
 * DOM contract (views/contra/form.ejs):
 *   Form: #contra-form
 *   Fields: #ct-date, #ct-from (+ #ct-from-menu), #ct-to (+ #ct-to-menu), #ct-amount
 *   Submit: #ct-submit
 *   Ledgers: window.CONTRA_LEDGERS [{id,name,parent}]
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var form = document.getElementById('contra-form');
        if (!form) return;

        var LEDGERS = Array.isArray(window.CONTRA_LEDGERS) ? window.CONTRA_LEDGERS : [];

        // ── One popup open at a time (outside click / Esc close it). Re-
        // registering the SAME popup must not close it: a single click fires
        // both mousedown and focus, and each re-opens (and so re-registers)
        // the combobox — closing "everything else" blindly would close this
        // popup's own just-opened menu, and the field would look dead. Close
        // only the OTHERS. See web/public/js/delivery-note.js for the same
        // fix, documented at length there. ──
        var openPopups = [];
        function closeAllPopups() {
            var list = openPopups;
            openPopups = [];
            list.forEach(function (p) { p.close(); });
        }
        function registerPopup(els, closeFn) {
            var others = openPopups.filter(function (p) { return p.close !== closeFn; });
            openPopups = [];
            others.forEach(function (p) { p.close(); });
            openPopups = [{ els: els, close: closeFn }];
        }
        function forgetPopup(closeFn) {
            openPopups = openPopups.filter(function (p) { return p.close !== closeFn; });
        }
        document.addEventListener('mousedown', function (e) {
            openPopups.slice().forEach(function (p) {
                var inside = p.els.some(function (el) { return el && el.contains(e.target); });
                if (!inside) p.close();
            });
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeAllPopups();
        });

        function openField(el) {
            if (!el || el.disabled) return;
            el.focus();
            if (el.select) el.select();
        }

        // Generic searchable combobox — text input + menu div, no hidden id
        // (the ledger NAME is what the form submits, in dr_ledger/cr_ledger).
        function makeCombobox(opts) {
            var active = -1, items = [];

            function place() {
                var r = opts.input.getBoundingClientRect();
                opts.menu.style.left  = r.left + 'px';
                opts.menu.style.top   = (r.bottom + 2) + 'px';
                opts.menu.style.width = r.width + 'px';
                // A line-item cell is ~200px wide; the option under it carries an HSN and a
                // stock figure as well as the name. Let the menu outgrow its field rather
                // than clip what it was opened to show — clamped so it never leaves the
                // viewport on a narrow screen.
                opts.menu.style.minWidth = Math.min(320, window.innerWidth - r.left - 16) + 'px';
            }
            function currentList() {
                // The OTHER field's already-chosen ledger cannot be picked
                // again here — a Contra's two sides must be different ledgers.
                var exclude = opts.excludeValue ? opts.excludeValue() : '';
                return LEDGERS.filter(function (l) { return l.name !== exclude; });
            }
            function render(list) {
                opts.menu.innerHTML = '';
                items = list;
                active = -1;
                if (!list.length) {
                    opts.menu.innerHTML = '<div class="li-prod-empty">No matches</div>';
                } else {
                    list.slice(0, 50).forEach(function (l, i) {
                        var d = document.createElement('div');
                        d.className = 'li-prod-item';
                        d.setAttribute('data-i', i);
                        var main = document.createElement('span');
                        main.textContent = l.name;
                        d.appendChild(main);
                        if (l.parent) {
                            var sub = document.createElement('span');
                            sub.className = 'li-prod-sub';
                            sub.textContent = l.parent;
                            d.appendChild(sub);
                        }
                        d.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
                        opts.menu.appendChild(d);
                    });
                    items = list.slice(0, 50);
                }
                opts.menu.hidden = false;
                registerPopup([opts.input, opts.menu], close);
                place();
            }
            function filter() {
                var q = opts.input.value.trim().toLowerCase();
                var list = currentList();
                if (q) list = list.filter(function (l) { return l.name.toLowerCase().indexOf(q) > -1; });
                render(list);
            }
            function close() { opts.menu.hidden = true; forgetPopup(close); }
            function choose(i) {
                var l = items[i];
                if (!l) return;
                opts.input.value = l.name;
                close();
                if (opts.onChoose) opts.onChoose(l);
            }
            function highlight() {
                opts.menu.querySelectorAll('.li-prod-item').forEach(function (el, i) {
                    el.classList.toggle('is-active', i === active);
                });
                var el = opts.menu.querySelector('.is-active');
                if (el) el.scrollIntoView({ block: 'nearest' });
            }

            window.addEventListener('scroll', function () { if (!opts.menu.hidden) place(); }, true);
            window.addEventListener('resize', function () { if (!opts.menu.hidden) place(); });

            opts.input.addEventListener('input', filter);
            opts.input.addEventListener('focus', function () { if (!opts.input.disabled) render(currentList()); });
            opts.input.addEventListener('mousedown', function () { if (!opts.input.disabled && opts.menu.hidden) render(currentList()); });
            opts.input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { close(); return; }
                if (opts.menu.hidden) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
                else if (e.key === 'Enter') { if (active > -1) { e.preventDefault(); choose(active); } }
            });
            opts.input.addEventListener('blur', function () { setTimeout(close, 150); });

            return { open: function () { openField(opts.input); filter(); } };
        }

        var dateEl   = document.getElementById('ct-date');
        var fromEl   = document.getElementById('ct-from');
        var toEl     = document.getElementById('ct-to');
        var amountEl = document.getElementById('ct-amount');

        if (!LEDGERS.length || !fromEl || !toEl) return; // honest empty state — nothing to wire

        var fromBox = makeCombobox({
            input: fromEl,
            menu:  document.getElementById('ct-from-menu'),
            excludeValue: function () { return toEl.value; },
            onChoose: function () {
                toEl.disabled = false;
                openField(toEl);
            },
        });
        var toBox = makeCombobox({
            input: toEl,
            menu:  document.getElementById('ct-to-menu'),
            excludeValue: function () { return fromEl.value; },
            onChoose: function () {
                amountEl.disabled = false;
                openField(amountEl);
            },
        });

        amountEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.submit(); }
        });

        // Keyboard-first: Date → From → To → Amount → submit.
        openField(dateEl);
        if (dateEl) dateEl.addEventListener('change', function () { fromBox.open(); });
    }
})();
