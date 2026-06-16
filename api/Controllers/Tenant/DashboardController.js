'use strict';

/**
 * api/Controllers/Tenant/DashboardController.js
 *
 * The read-only dashboard aggregate — backs GET /dashboard/summary. Unlike the
 * crudController-wired resources this is a bespoke, query-heavy controller that
 * rolls many small company-scoped aggregates into ONE response object. It writes
 * nothing; every query is scoped by req.companyId (set by resolveCompany) and,
 * on the soft-deletable tenant tables, filtered with whereNull('deleted_at').
 *
 * Exports a single handler { summary }. The returned object shape:
 *
 *   {
 *     counts: {
 *       companies, customers, products, suppliers,   // not-deleted counts
 *       today_sales,        // Σ invoices.total, type='sales', status!='failed',
 *                           //   invoice_date >= first-of-this-month
 *       pending_sync,       // customers(tally_guid NULL) + products(tally_guid NULL)
 *                           //   + invoices(status='pending_tally')
 *                           //   + payments(status='pending_tally')
 *       stock_value,        // Σ products.sales_price * products.opening_stock
 *       invoice_amount,     // Σ invoices.total where type='sales'
 *       payment_received    // Σ payments.amount where type='receipt'
 *     },
 *     sales_chart: { labels:[12 month short names], data:[Σ sales total / month] },
 *     sync_chart:  { labels:['Synced','Pending','Failed'], data:[3 counts] },
 *     recent_invoices: [ { invoice_no, customer, total, status, invoice_date } x6 ],
 *     recent_sync:     [ { module, record_type, record_id, status, created_at } x6 ]
 *   }
 *
 * Every numeric value pg returns as a string is wrapped in Number(...) so the
 * payload carries real JS numbers (never "123.00").
 *
 * Conventions: 'use strict', 4-space indent, async handler + try/catch →
 * console.error + errorResponse(res, OOPS_MSG, 500). Uses the shared response
 * envelope (successResponse) and the single shared Knex instance.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// Short month labels for the rolling 12-month sales chart axis.
const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Coerce a pg numeric (string | null | number) into a real JS number, 0 on null.
function num(x) {
    return Number(x || 0);
}

// Validate a 'YYYY-MM-DD' query param → return it (string) or null.
function parseDate(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// First day of the current month as "YYYY-MM-01" (for the today_sales filter).
function firstOfThisMonth() {
    const d   = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

/**
 * GET /dashboard/summary — assemble every company-scoped aggregate into one
 * object. All independent queries are fired together (Promise.all) since none
 * depend on another's result.
 */
async function summary(req, res) {
    try {
        const companyId   = req.companyId;
        const monthStart  = firstOfThisMonth();

        // Optional dashboard date range (from the header date-range picker).
        // When both are valid YYYY-MM-DD (from ≤ to), the date-sensitive money
        // metrics + recent invoices scope to [from, to]; otherwise their
        // original defaults apply (today_sales = this month; rest = all-time).
        const from = parseDate(req.query.from);
        const to   = parseDate(req.query.to);
        const hasRange = !!(from && to && from <= to);

        const todaySalesQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed');
        if (hasRange) todaySalesQ.whereBetween('invoice_date', [from, to]);
        else todaySalesQ.where('invoice_date', '>=', monthStart);

        const invoiceAmountQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales');
        if (hasRange) invoiceAmountQ.whereBetween('invoice_date', [from, to]);

        const paymentReceivedQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt');
        if (hasRange) paymentReceivedQ.whereBetween('payment_date', [from, to]);

        const recentInvoicesQ = db('invoices')
            .leftJoin('customers', 'customers.id', 'invoices.customer_id')
            .where('invoices.company_id', companyId)
            .whereNull('invoices.deleted_at')
            .where('invoices.type', 'sales');
        if (hasRange) recentInvoicesQ.whereBetween('invoices.invoice_date', [from, to]);
        recentInvoicesQ.orderBy('invoices.id', 'desc').limit(6).select(
            'invoices.invoice_no',
            'customers.name as customer',
            'invoices.total',
            'invoices.status',
            'invoices.invoice_date',
        );

        const [
            companiesCnt,
            customersCnt,
            productsCnt,
            suppliersCnt,
            todaySalesRow,
            pendingCustomersRow,
            pendingProductsRow,
            pendingInvoicesRow,
            pendingPaymentsRow,
            stockValueRow,
            invoiceAmountRow,
            paymentReceivedRow,
            salesByMonth,
            syncSyncedRow,
            syncFailedRow,
            recentInvoices,
            recentSync,
        ] = await Promise.all([
            // ── counts ──────────────────────────────────────────────
            db('companies').whereNull('deleted_at').count('id as c').first(),

            db('customers').where('company_id', companyId)
                .whereNull('deleted_at').count('id as c').first(),

            db('products').where('company_id', companyId)
                .whereNull('deleted_at').count('id as c').first(),

            db('suppliers').where('company_id', companyId)
                .whereNull('deleted_at').count('id as c').first(),

            // today_sales — sales total for the selected range (else this month).
            todaySalesQ.sum('total as s').first(),

            // pending_sync parts (summed below).
            db('customers').where('company_id', companyId)
                .whereNull('deleted_at').whereNull('tally_guid')
                .count('id as c').first(),

            db('products').where('company_id', companyId)
                .whereNull('deleted_at').whereNull('tally_guid')
                .count('id as c').first(),

            db('invoices').where('company_id', companyId)
                .whereNull('deleted_at').where('status', 'pending_tally')
                .count('id as c').first(),

            db('payments').where('company_id', companyId)
                .whereNull('deleted_at').where('status', 'pending_tally')
                .count('id as c').first(),

            // stock_value — Σ sales_price * opening_stock over live products.
            db('products').where('company_id', companyId)
                .whereNull('deleted_at')
                .sum(db.raw('sales_price * opening_stock')).first(),

            // invoice_amount — Σ total over sales invoices (range-scoped).
            invoiceAmountQ.sum('total as s').first(),

            // payment_received — Σ amount over receipt vouchers (range-scoped).
            paymentReceivedQ.sum('amount as s').first(),

            // ── sales_chart — monthly sales totals, grouped by month bucket ──
            db('invoices').where('company_id', companyId)
                .whereNull('deleted_at').where('type', 'sales')
                .where('invoice_date', '>=', db.raw("date_trunc('month', now()) - interval '11 months'"))
                .select(db.raw("date_trunc('month', invoice_date) as m"))
                .sum('total as s')
                .groupByRaw("date_trunc('month', invoice_date)"),

            // ── sync_chart — synced / failed log counts (pending computed below) ──
            db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'synced').count('id as c').first(),

            db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'failed').count('id as c').first(),

            // ── recent_invoices — last 6 sales invoices (range-scoped) ──
            recentInvoicesQ,

            // ── recent_sync — last 6 sync log entries ──
            db('tally_sync_logs').where('company_id', companyId)
                .orderBy('id', 'desc')
                .limit(6)
                .select('module', 'record_type', 'record_id', 'status', 'created_at'),
        ]);

        // pending_sync — sum of the four pending buckets.
        const pendingSync =
            num(pendingCustomersRow && pendingCustomersRow.c) +
            num(pendingProductsRow  && pendingProductsRow.c) +
            num(pendingInvoicesRow  && pendingInvoicesRow.c) +
            num(pendingPaymentsRow  && pendingPaymentsRow.c);

        // sales_chart — build the rolling 12-month axis (oldest → newest) and
        // fill each slot from the grouped query, defaulting gaps to 0.
        const now    = new Date();
        const labels = [];
        const buckets = [];   // YYYY-MM keys aligned with labels
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            labels.push(MONTH_NAMES[d.getMonth()]);
            buckets.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        const salesMap = {};
        for (const row of salesByMonth) {
            const m   = new Date(row.m);
            const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
            salesMap[key] = num(row.s);
        }
        const salesData = buckets.map((key) => salesMap[key] || 0);

        const counts = {
            companies:        num(companiesCnt && companiesCnt.c),
            customers:        num(customersCnt && customersCnt.c),
            products:         num(productsCnt  && productsCnt.c),
            suppliers:        num(suppliersCnt && suppliersCnt.c),
            today_sales:      num(todaySalesRow && todaySalesRow.s),
            pending_sync:     pendingSync,
            stock_value:      num(stockValueRow && stockValueRow.sum),
            invoice_amount:   num(invoiceAmountRow && invoiceAmountRow.s),
            payment_received: num(paymentReceivedRow && paymentReceivedRow.s),
        };

        const sync_chart = {
            labels: ['Synced', 'Pending', 'Failed'],
            data: [
                num(syncSyncedRow && syncSyncedRow.c),
                pendingSync,
                num(syncFailedRow && syncFailedRow.c),
            ],
        };

        return R.successResponse(res, {
            counts,
            range: hasRange ? { from, to } : null,
            sales_chart: { labels, data: salesData },
            sync_chart,
            recent_invoices: recentInvoices,
            recent_sync:     recentSync,
        });
    } catch (err) {
        console.error('dashboard.summary error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { summary };
