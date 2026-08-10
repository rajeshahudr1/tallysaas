'use strict';

/* ─────────────────────────────────────────────────────────────
 * report-favourites.js — the Favourites strip on the Reports hub.
 *
 * LiveKeeping pins your handful of everyday reports above the full
 * catalogue. Ours has more than fifty cards across ten sections, so the
 * strip matters more here, not less: without it the four reports someone
 * opens daily are four scrolls apart.
 *
 * Stored in localStorage, NOT on the server. Which reports a person likes is
 * a per-person, per-device preference with no bearing on anyone else's work
 * and nothing to reconcile with Tally — a column on a shared table would make
 * the owner and the accountant fight over one strip. The cost is that the
 * list does not follow you to another browser, which is the right trade for a
 * shortcut bar.
 *
 * Cards are identified by href: it is already unique per report, already in
 * the DOM, and survives a card being retitled.
 * ─────────────────────────────────────────────────────────── */

(function () {
    var KEY = 'teloora.reportFavourites';

    function load() {
        try {
            var raw = window.localStorage.getItem(KEY);
            var list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (_) {
            // Private browsing, a full quota, or someone's hand-edited JSON.
            // A broken shortcut bar must not take the Reports page with it.
            return [];
        }
    }

    function save(list) {
        try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* see above */ }
    }

    document.addEventListener('DOMContentLoaded', function () {
        var strip = document.getElementById('report-favourites');
        var stripGrid = document.getElementById('report-favourites-grid');
        var empty = document.getElementById('report-favourites-empty');
        var cards = [].slice.call(document.querySelectorAll('.report-card[href]'));
        if (!strip || !stripGrid || !cards.length) return;

        function render() {
            var favs = load();
            stripGrid.innerHTML = '';
            var shown = 0;
            favs.forEach(function (href) {
                var src = cards.filter(function (c) { return c.getAttribute('href') === href; })[0];
                if (!src) return;              // a report that no longer exists
                var copy = src.cloneNode(true);
                copy.classList.add('is-favourite-copy');
                // The copy keeps its own star, so a report can be un-pinned
                // from the strip itself rather than by hunting for the
                // original card further down the page.
                wireStar(copy);
                stripGrid.appendChild(copy);
                shown += 1;
            });
            if (empty) empty.hidden = shown > 0;
            // Mark the originals so their stars read the right way round.
            cards.forEach(function (c) {
                var on = favs.indexOf(c.getAttribute('href')) > -1;
                c.classList.toggle('is-starred', on);
                var btn = c.querySelector('.report-star');
                if (btn) {
                    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                    btn.title = on ? 'Remove from Favourites' : 'Add to Favourites';
                    btn.innerHTML = on
                        ? '<i class="fa-solid fa-star"></i>'
                        : '<i class="fa-regular fa-star"></i>';
                }
            });
        }

        function toggle(href) {
            var favs = load();
            var i = favs.indexOf(href);
            if (i > -1) favs.splice(i, 1); else favs.push(href);
            save(favs);
            render();
        }

        function wireStar(card) {
            var btn = card.querySelector('.report-star');
            if (!btn) return;
            btn.addEventListener('click', function (e) {
                // The card is a link; a click on its star must pin the report,
                // not navigate away from the page you are pinning it on.
                e.preventDefault();
                e.stopPropagation();
                toggle(card.getAttribute('href'));
            });
        }

        cards.forEach(wireStar);
        strip.hidden = false;
        render();
    });
})();
