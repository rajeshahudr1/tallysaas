'use strict';

/* ─────────────────────────────────────────────────────────────
 * dashboard.js — Chart.js initialisation for the Dashboard page.
 *
 * Renders:
 *   • Sales & Receipt — grouped bar chart (12 months, two series).
 *   • Receivables — ageing doughnut (six bands, colours supplied
 *     by the server so the arcs match the legend swatches).
 *
 * Also owns the page's AJAX behaviour. Every dashboard control (the
 * period <select>, the Day Book day pills, the date input) re-renders
 * ONLY its own panel from GET /dashboard/section — the browser URL is
 * never touched, so no ?range= / ?daybook= ever appears in the address
 * bar and untouched panels are not re-queried. The Top 10 tabs switch
 * entirely client-side (all six datasets ship with the panel).
 *
 * Data source: each chart FRAGMENT embeds its own JSON island
 *   <script type="application/json" data-chart="salesReceipt">…</script>
 * so numbers stay server-owned and travel with the fragment on a swap.
 *
 * Every step is guarded: if Chart.js failed to load (offline / blocked
 * CDN), a canvas is missing, or a fetch fails, we no-op (leaving the
 * existing panel in place) instead of throwing.
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    // Live Chart.js instances, keyed by canvas id, so a panel swap can destroy
    // the old chart before the canvas it drew on is removed from the DOM.
    var charts = {};

    // What each panel is currently showing. Held in memory rather than the URL —
    // the address bar must stay clean (no ?range=, no ?daybook=). `range` is
    // keyed BY SECTION: every panel owns its own period, so changing the
    // Summary select never touches Sales & Receipt and vice versa.
    var state = { range: {}, daybook: '' };

    function init() {
        wireAll(document);
        renderCharts(document);
    }

    /* Wire every control inside `scope`. Called on load and again after each
     * fragment swap, since the swapped-in markup carries fresh controls. */
    function wireAll(scope) {
        initTop10Tabs(scope);
        initRangeSelect(scope);
        initDayBookControls(scope);
    }

    /* (Re)build the charts for whatever chart fragments live in `scope`. */
    function renderCharts(scope) {
        if (typeof window.Chart === 'undefined') return;   // CDN missing → skip
        initSalesReceiptChart(readChart(scope, 'salesReceipt'));
        initReceivablesChart(readChart(scope, 'receivables'));
    }

    /* ── Fragment loading ─────────────────────────────────────────
     * Each panel re-renders itself from GET /dashboard/section. Only the
     * panel that changed is fetched; history.pushState is deliberately NOT
     * used, so the visible URL never gains query parameters. */
    function sectionUrl(section) {
        var qs = ['section=' + encodeURIComponent(section)];
        if (state.range[section]) qs.push('range=' + encodeURIComponent(state.range[section]));
        if (state.daybook) qs.push('daybook=' + encodeURIComponent(state.daybook));
        return '/dashboard/section?' + qs.join('&');
    }

    // Per-section request counter: a slow earlier response must not overwrite
    // the panel a later (faster) request has already rendered.
    var reqSeq = {};

    function loadSections(sections) {
        sections.forEach(function (section) {
            var host = document.querySelector('[data-dash-section="' + section + '"]');
            if (!host) return;

            var seq = (reqSeq[section] = (reqSeq[section] || 0) + 1);
            host.classList.add('is-loading');

            fetch(sectionUrl(section), {
                headers: { 'X-Requested-With': 'fetch' },
                credentials: 'same-origin',
            })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                })
                .then(function (html) {
                    if (reqSeq[section] !== seq) return;   // superseded → drop

                    // Destroy any chart drawn on a canvas inside the outgoing
                    // markup — Chart.js keeps a registry keyed by canvas and
                    // would otherwise leak and refuse to re-init.
                    host.querySelectorAll('canvas').forEach(function (c) {
                        if (charts[c.id]) { charts[c.id].destroy(); delete charts[c.id]; }
                    });

                    var wrap = document.createElement('div');
                    wrap.innerHTML = html.trim();
                    var fresh = wrap.querySelector('[data-dash-section]') || wrap.firstElementChild;
                    if (!fresh) { host.classList.remove('is-loading'); return; }

                    host.replaceWith(fresh);
                    wireAll(fresh);
                    renderCharts(fresh);
                })
                .catch(function () {
                    // Leave the existing panel in place — a stale panel beats a
                    // blank one — and drop the loading state so it stays usable
                    // (unless a newer request is still in flight over it).
                    if (reqSeq[section] === seq) host.classList.remove('is-loading');
                });
        });
    }

    /* ── Panel date range ─────────────────────────────────────────
     * A range <select> belongs to the panel it sits in: changing it
     * re-renders ONLY that panel, with its own period. Summary and
     * Sales & Receipt therefore move independently. */
    function initRangeSelect(scope) {
        scope.querySelectorAll('[data-dash-range]').forEach(function (sel) {
            if (sel.dataset.wired) return;
            sel.dataset.wired = '1';

            var host = sel.closest('[data-dash-section]');
            if (!host) return;
            var section = host.getAttribute('data-dash-section');
            if (!state.range[section]) state.range[section] = sel.value;

            sel.addEventListener('change', function () {
                state.range[section] = sel.value;
                loadSections([section]);
            });
        });
    }

    /* ── Day Book day picker ──────────────────────────────────────
     * Today / Yesterday / the date input all reload the Day Book panel
     * alone. */
    function initDayBookControls(scope) {
        scope.querySelectorAll('[data-daybook]').forEach(function (btn) {
            if (btn.dataset.wired) return;
            btn.dataset.wired = '1';
            btn.addEventListener('click', function () {
                state.daybook = btn.getAttribute('data-daybook');
                loadSections(['daybook']);
            });
        });

        scope.querySelectorAll('[data-daybook-custom]').forEach(function (btn) {
            if (btn.dataset.wired) return;
            btn.dataset.wired = '1';
            btn.addEventListener('click', function () {
                openDatePicker(btn, btn.getAttribute('data-daybook-custom'), function (iso) {
                    state.daybook = iso;
                    loadSections(['daybook']);
                });
            });
        });
    }

    /* ── Themed date picker ───────────────────────────────────────
     * Lives in /js/datepicker.js now — the same popup every date field in
     * the app uses. It used to be defined here, which is why the Day Book
     * was the only themed calendar in the product. */
    function openDatePicker(anchor, isoValue, onApply) {
        window.Datepicker.open(anchor, isoValue, onApply);
    }

    /* ── Top 10 tab strip ─────────────────────────────────────────
     * All six leaderboards are rendered server-side; switching tab just
     * shows one panel and hides the rest, so there is no round trip. */
    function initTop10Tabs(scope) {
        var tabs = scope.querySelectorAll('[data-top10-tab]');
        if (!tabs.length) return;

        var strip = scope.querySelector('[data-top10-strip]');

        // Show a chevron only when there is actually something to scroll to,
        // so a strip that fits shows no controls at all.
        function syncArrows() {
            if (!strip) return;
            var max = strip.scrollWidth - strip.clientWidth;
            scope.querySelectorAll('[data-top10-scroll]').forEach(function (btn) {
                var dir = Number(btn.getAttribute('data-top10-scroll'));
                btn.hidden = (max <= 1) || (dir < 0 ? strip.scrollLeft <= 1 : strip.scrollLeft >= max - 1);
            });
        }

        if (strip && !strip.dataset.wired) {
            strip.dataset.wired = '1';
            strip.addEventListener('scroll', syncArrows);
            window.addEventListener('resize', syncArrows);

            scope.querySelectorAll('[data-top10-scroll]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    // Page by roughly one screen of tabs.
                    strip.scrollBy({ left: Number(btn.getAttribute('data-top10-scroll')) * (strip.clientWidth * 0.7), behavior: 'smooth' });
                });
            });
            syncArrows();
        }

        tabs.forEach(function (tab) {
            if (tab.dataset.wired) return;
            tab.dataset.wired = '1';
            tab.addEventListener('click', function () {
                var key = tab.getAttribute('data-top10-tab');

                scope.querySelectorAll('[data-top10-tab]').forEach(function (t) {
                    var on = t === tab;
                    t.classList.toggle('is-active', on);
                    t.setAttribute('aria-selected', String(on));
                });
                scope.querySelectorAll('[data-top10-panel]').forEach(function (panel) {
                    panel.hidden = panel.getAttribute('data-top10-panel') !== key;
                });
                // Scroll the chosen tab fully into view, revealing the next
                // tab along — clicking the last visible tab pages forward,
                // clicking the first pages back.
                if (strip) {
                    var pad = 48;   // leave the neighbouring tab peeking
                    var left  = tab.offsetLeft - pad;
                    var right = tab.offsetLeft + tab.offsetWidth + pad;
                    if (left < strip.scrollLeft) {
                        strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
                    } else if (right > strip.scrollLeft + strip.clientWidth) {
                        strip.scrollTo({ left: right - strip.clientWidth, behavior: 'smooth' });
                    }
                    syncArrows();
                }
            });
        });
    }

    /* Format a number as short Indian currency for axis ticks. */
    function shortInr(v) {
        var n = Number(v) || 0;
        if (Math.abs(n) >= 10000000) return '₹' + (n / 10000000).toFixed(1) + 'Cr';
        if (Math.abs(n) >= 100000)   return '₹' + (n / 100000).toFixed(1) + 'L';
        if (Math.abs(n) >= 1000)     return '₹' + Math.round(n / 1000) + 'k';
        return '₹' + n;
    }

    function fullInr(v) {
        return '₹' + Number(v || 0).toLocaleString('en-IN');
    }

    /* Read one chart fragment's JSON island. Returns null when this scope has
     * no such island (e.g. only the Day Book was swapped), which tells the
     * caller to leave that chart alone. */
    function readChart(scope, name) {
        var sel = '[data-chart="' + name + '"]';
        var el = (scope.matches && scope.matches(sel)) ? scope : scope.querySelector(sel);
        if (!el) return null;
        try { return JSON.parse(el.textContent || '{}'); } catch (e) { return null; }
    }

    /* ── Sales & Receipt (grouped bar) ────────────────────────── */
    function initSalesReceiptChart(sales) {
        var canvas = document.getElementById('salesChart');
        if (!canvas || !sales) return;
        if (charts.salesChart) charts.salesChart.destroy();

        charts.salesChart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: sales.labels || [],
                datasets: [
                    {
                        label: 'Sales',
                        data: sales.sales || [],
                        backgroundColor: '#16A34A',
                        borderRadius: 3,
                        maxBarThickness: 18,
                    },
                    {
                        label: 'Receipt',
                        data: sales.receipt || [],
                        backgroundColor: '#BBF7D0',
                        borderRadius: 3,
                        maxBarThickness: 18,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: '#6B7280', usePointStyle: true,
                            pointStyle: 'rect', padding: 14, boxWidth: 10,
                            font: { size: 11 },
                        },
                    },
                    tooltip: {
                        callbacks: {
                            label: function (c) { return c.dataset.label + ': ' + fullInr(c.parsed.y); },
                        },
                    },
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#6B7280', font: { size: 11 } } },
                    y: {
                        beginAtZero: true,
                        grid: { color: '#F1F2F4' },
                        ticks: { color: '#6B7280', font: { size: 11 }, callback: shortInr },
                    },
                },
            },
        });
    }

    /* ── Receivables ageing (doughnut) ────────────────────────── */
    function initReceivablesChart(recv) {
        var canvas = document.getElementById('receivablesChart');
        if (!canvas || !recv) return;
        if (charts.receivablesChart) charts.receivablesChart.destroy();

        var real = recv.data || [];

        /* A band holding a rounding-error amount (e.g. ₹399 out of ₹2.6L is
         * 0.15%) draws an arc under half a degree wide — invisible, so the
         * ring looks like it is missing a band that the legend clearly lists.
         * Give every NON-ZERO band a floor of MIN_SHARE of the ring. The
         * legend and the tooltip both still report the true rupee amount;
         * only the arc width is nudged. */
        var MIN_SHARE = 0.02;
        var total = real.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
        var plotted = real;
        if (total > 0) {
            var floor = total * MIN_SHARE;
            plotted = real.map(function (v) {
                var n = Number(v) || 0;
                return (n > 0 && n < floor) ? floor : n;
            });
        }

        charts.receivablesChart = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: recv.labels || [],
                datasets: [{
                    data: plotted,
                    // True values, kept for the tooltip callback below.
                    realData: real,
                    backgroundColor: recv.colors || [],
                    borderColor: '#fff',
                    borderWidth: 2,
                    hoverOffset: 6,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '66%',
                plugins: {
                    // The panel renders its own legend beside the chart (with
                    // amounts), so Chart.js's built-in one would duplicate it.
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            // Report the REAL amount, not the widened arc value.
                            label: function (c) {
                                var src = c.dataset.realData || [];
                                var v = (src[c.dataIndex] !== undefined) ? src[c.dataIndex] : c.parsed;
                                return c.label + ': ' + fullInr(v);
                            },
                        },
                    },
                },
            },
        });
    }
})();
