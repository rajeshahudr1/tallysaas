/* ─────────────────────────────────────────────────────────────
 * public/js/datepicker.js — ONE date popup for the whole app.
 *
 * The Day Book's themed calendar (dashboard.js) was the only one in the
 * product; every other date on every form fell back to <input type="date">,
 * whose popup is drawn by the browser, cannot be themed, and looks different
 * in every browser. This file lifts that calendar out so any field can use it.
 *
 * Two ways in:
 *   1. Automatic — every <input type="date"> on the page is enhanced on load
 *      (and any added later, via the MutationObserver). The input KEEPS its
 *      type, id, name and ISO value, so nothing that reads or posts it changes;
 *      only the browser's own picker is suppressed and ours opens instead.
 *   2. window.Datepicker.open(anchor, isoValue, onApply) — for a button or any
 *      non-input anchor, exactly as the Day Book uses it.
 *
 * Applying a date writes input.value and fires `input` + `change`, so existing
 * listeners (totals, "valid till" bounds, autosave) behave as if the user typed.
 * ───────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    var DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

    function pad2(n) { return String(n).padStart(2, '0'); }
    function toIso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function fromIso(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    }
    function sameDay(a, b) {
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate();
    }

    var openDp = null;   // the one calendar that may be open at a time

    function closeDatePicker(dp) {
        if (!dp) return;
        if (dp._cleanup) dp._cleanup();
        if (dp._anchor && dp._anchor.setAttribute) dp._anchor.setAttribute('aria-expanded', 'false');
        dp.remove();
        if (openDp === dp) openDp = null;
    }

    /* opts.min / opts.max — ISO strings; days outside are shown but not
       selectable. Used by "Valid Till", which cannot precede the voucher date. */
    function openDatePicker(anchor, isoValue, onApply, opts) {
        opts = opts || {};

        // Second click on the same anchor closes; a click on a different one
        // swaps the popup over to it.
        if (openDp) {
            var wasSame = openDp._anchor === anchor;
            closeDatePicker(openDp);
            if (wasSame) return;
        }

        var selected = fromIso(isoValue);
        var view = new Date(selected.getFullYear(), selected.getMonth(), 1);
        var today = new Date();
        var min = opts.min ? fromIso(opts.min) : null;
        var max = opts.max ? fromIso(opts.max) : null;

        // Parented to <body>, NOT to the field's card: a card with
        // `overflow: hidden` would clip a popup positioned inside it. Fixed
        // coordinates are recomputed from the anchor on every scroll.
        var dp = document.createElement('div');
        dp.className = 'dp';
        dp.setAttribute('role', 'dialog');
        dp._anchor = anchor;
        document.body.appendChild(dp);
        openDp = dp;
        if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');

        function place() {
            var r = anchor.getBoundingClientRect();
            var w = dp.offsetWidth, h = dp.offsetHeight, gap = 6, edge = 8;

            // Left-aligned to the field (right-aligned would drift off a wide
            // input), then pulled back inside the viewport.
            var left = Math.min(Math.max(edge, r.left), window.innerWidth - w - edge);
            var top = r.bottom + gap;
            if (top + h > window.innerHeight - edge) {
                top = (r.top - gap - h >= edge) ? r.top - gap - h
                                                : Math.max(edge, window.innerHeight - h - edge);
            }
            dp.style.left = Math.round(left) + 'px';
            dp.style.top = Math.round(top) + 'px';
        }

        function blocked(d) {
            if (min && d < min && !sameDay(d, min)) return true;
            if (max && d > max && !sameDay(d, max)) return true;
            return false;
        }

        function draw() {
            var first = new Date(view.getFullYear(), view.getMonth(), 1);
            // Monday-first: shift Sunday (0) to the end of the week.
            var lead = (first.getDay() + 6) % 7;
            var start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

            var cells = '';
            for (var i = 0; i < 42; i++) {
                var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
                var cls = 'dp-day';
                if (d.getMonth() !== view.getMonth()) cls += ' is-muted';
                if (sameDay(d, today)) cls += ' is-today';
                if (sameDay(d, selected)) cls += ' is-selected';
                var off = blocked(d);
                if (off) cls += ' is-disabled';
                cells += '<button type="button" class="' + cls + '"' + (off ? ' disabled' : '')
                       + ' data-dp-day="' + toIso(d) + '">' + d.getDate() + '</button>';
            }

            dp.innerHTML =
                '<div class="dp-head">'
              +   '<button type="button" class="dp-nav" data-dp-move="-1" aria-label="Previous month">'
              +     '<i class="fa-solid fa-chevron-left"></i></button>'
              +   '<span class="dp-title">' + MONTHS[view.getMonth()] + ' ' + view.getFullYear() + '</span>'
              +   '<button type="button" class="dp-nav" data-dp-move="1" aria-label="Next month">'
              +     '<i class="fa-solid fa-chevron-right"></i></button>'
              + '</div>'
              + '<div class="dp-grid">'
              +   DOW.map(function (d) { return '<span class="dp-dow">' + d + '</span>'; }).join('')
              +   cells
              + '</div>'
              + '<div class="dp-foot">'
              +   '<span class="dp-value">' + pad2(selected.getDate()) + '/'
              +     pad2(selected.getMonth() + 1) + '/' + selected.getFullYear() + '</span>'
              +   '<span class="dp-actions">'
              +     '<button type="button" class="dp-btn" data-dp-today>Today</button>'
              +     '<button type="button" class="dp-btn dp-btn--apply" data-dp-apply>Apply</button>'
              +   '</span>'
              + '</div>';

            place();
        }

        dp.addEventListener('click', function (ev) {
            // Stop here: ‹ › and the day cells call draw(), which REPLACES the
            // popup's innerHTML. By the time this click reaches the document
            // listener its target is detached, so `dp.contains(target)` is
            // false and the outside-click guard would close the calendar.
            ev.stopPropagation();

            var move = ev.target.closest('[data-dp-move]');
            if (move) { view.setMonth(view.getMonth() + Number(move.getAttribute('data-dp-move'))); draw(); return; }

            var day = ev.target.closest('[data-dp-day]');
            if (day) {
                selected = fromIso(day.getAttribute('data-dp-day'));
                // Picking a day from an adjacent month follows it into view.
                view = new Date(selected.getFullYear(), selected.getMonth(), 1);
                draw();
                return;
            }

            if (ev.target.closest('[data-dp-today]')) {
                selected = new Date();
                view = new Date(selected.getFullYear(), selected.getMonth(), 1);
                draw();
                return;
            }
            if (ev.target.closest('[data-dp-cancel]')) { closeDatePicker(dp); return; }
            if (ev.target.closest('[data-dp-apply]')) { closeDatePicker(dp); onApply(toIso(selected)); }
        });

        // Dismiss on outside click / Escape. Registered on the next tick so the
        // click that opened the popup does not immediately close it.
        function onDocClick(ev) {
            if (!dp.contains(ev.target) && !(anchor.contains && anchor.contains(ev.target)) && ev.target !== anchor) {
                closeDatePicker(dp);
            }
        }
        function onKey(ev) { if (ev.key === 'Escape') closeDatePicker(dp); }
        setTimeout(function () {
            document.addEventListener('click', onDocClick);
            document.addEventListener('keydown', onKey);
        }, 0);
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        dp._cleanup = function () {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };

        draw();
    }

    /* ── Automatic enhancement of <input type="date"> ──────────────────
     * The input is left completely alone apart from a marker class: same
     * element, same name, same ISO value. All this does is open OUR popup on
     * click/focus instead of leaving the user with the browser's. The native
     * picker is suppressed in CSS (the calendar indicator is hidden), which is
     * the only part a page cannot do from script. */
    function enhance(input) {
        if (!input || input.dataset.dpBound) return;
        input.dataset.dpBound = '1';
        input.classList.add('dp-input');

        function open(ev) {
            if (input.disabled || input.readOnly) return;
            ev.preventDefault();
            // A native picker may still be reachable by keyboard on some
            // browsers; ours is what a click gets.
            openDatePicker(input, input.value, function (iso) {
                input.value = iso;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, { min: input.getAttribute('min') || '', max: input.getAttribute('max') || '' });
        }

        input.addEventListener('mousedown', open);
        // Keyboard users land here by Tab; Enter/Space/Down opens the same popup.
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') open(ev);
        });
    }

    function enhanceAll(root) {
        (root || document).querySelectorAll('input[type="date"]').forEach(enhance);
    }

    function init() {
        enhanceAll(document);
        // Line-item rows, modals and anything else rendered after load.
        new MutationObserver(function (records) {
            records.forEach(function (r) {
                r.addedNodes.forEach(function (n) {
                    if (n.nodeType !== 1) return;
                    if (n.matches && n.matches('input[type="date"]')) enhance(n);
                    else if (n.querySelectorAll) enhanceAll(n);
                });
            });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.Datepicker = { open: openDatePicker, close: function () { closeDatePicker(openDp); }, enhance: enhance };
})();
