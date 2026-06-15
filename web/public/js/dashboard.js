'use strict';

/* ─────────────────────────────────────────────────────────────
 * dashboard.js — Chart.js initialisation for the Dashboard page.
 *
 * Renders:
 *   • Sales Overview — line chart (monthly).
 *   • Tally Sync Status — doughnut (Synced / Pending / Failed).
 *
 * Data source: the dashboard view embeds a JSON island
 *   <script type="application/json" id="dashboardData">{ sales, sync }</script>
 * so numbers live in data/mock.js (server-side), not hard-coded here.
 *
 * Every step is guarded: if Chart.js failed to load (offline / blocked
 * CDN) or a canvas is missing, we no-op instead of throwing.
 * ─────────────────────────────────────────────────────────── */

(function () {
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        if (typeof window.Chart === 'undefined') return;   // CDN missing → skip

        var data = readData();

        initSalesChart(data.sales);
        initSyncChart(data.sync);
    }

    /* Read + parse the JSON island; fall back to sensible defaults. */
    function readData() {
        var fallback = {
            sales: { labels: [], data: [] },
            sync:  { labels: ['Synced', 'Pending', 'Failed'], data: [0, 0, 0] },
        };
        var el = document.getElementById('dashboardData');
        if (!el) return fallback;
        try {
            var parsed = JSON.parse(el.textContent || '{}');
            return {
                sales: parsed.sales || fallback.sales,
                sync:  parsed.sync  || fallback.sync,
            };
        } catch (e) {
            return fallback;
        }
    }

    /* ── Sales Overview (line) ────────────────────────────────── */
    function initSalesChart(sales) {
        var canvas = document.getElementById('salesChart');
        if (!canvas || !sales) return;

        var ctx = canvas.getContext('2d');
        var grad = ctx.createLinearGradient(0, 0, 0, 280);
        grad.addColorStop(0, 'rgba(37,99,235,.22)');
        grad.addColorStop(1, 'rgba(37,99,235,0)');

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: sales.labels,
                datasets: [{
                    label: 'Sales',
                    data: sales.data,
                    borderColor: '#2563EB',
                    backgroundColor: grad,
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: '#2563EB',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: function (c) { return '₹' + Number(c.parsed.y).toLocaleString('en-IN'); } },
                    },
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#6B7280' } },
                    y: {
                        grid: { color: '#F1F2F4' },
                        ticks: {
                            color: '#6B7280',
                            callback: function (v) { return '₹' + (v / 1000) + 'k'; },
                        },
                    },
                },
            },
        });
    }

    /* ── Tally Sync Status (doughnut) ─────────────────────────── */
    function initSyncChart(sync) {
        var canvas = document.getElementById('syncChart');
        if (!canvas || !sync) return;

        new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: sync.labels,
                datasets: [{
                    data: sync.data,
                    backgroundColor: ['#16A34A', '#D97706', '#DC2626'],
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
                    legend: {
                        position: 'bottom',
                        labels: { color: '#6B7280', usePointStyle: true, pointStyle: 'circle', padding: 16, boxWidth: 8 },
                    },
                },
            },
        });
    }
})();
