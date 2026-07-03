'use strict';

/**
 * api/Controllers/Tenant/AnalyticsController.js
 *
 * Business Analytics — one read-only bundle of company-scoped insights for the
 * Analytics page (web + app). Everything is derived from the existing invoice /
 * payment / invoice_item data; nothing is written.
 *
 *   overview GET /account/analytics
 *     → { kpis, sales_trend, cashflow, top_customers, top_products, aging }
 *
 * Outstanding (for receivables aging) is self-contained, matching the reminders
 * model: opening_balance + Σ sales invoice totals − Σ receipt amounts.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS = 'Oops..Something went wrong. Please try again.';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (x) => Number(x || 0);
const r2  = (n) => Math.round(n * 100) / 100;

function firstOfThisMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// The rolling 12-month axis (oldest → newest): labels like "Jan '25" + YYYY-MM keys.
function build12Months(anchor) {
    const now = anchor || new Date();
    const labels = [], keys = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        labels.push(`${MONTH_NAMES[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return { labels, keys };
}

// Turn grouped { m: date, s: sum } rows into an array aligned to the 12-month keys.
function fillMonthly(rows, keys) {
    const map = {};
    for (const row of rows) {
        const m = new Date(row.m);
        map[`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`] = num(row.s);
    }
    return keys.map((k) => map[k] || 0);
}

async function overview(req, res) {
    try {
        const companyId = req.companyId;
        // Field-sales scoping: a salesman sees analytics ONLY for the invoices
        // THEY created (mirrors the invoice list / dashboard scoping). No-op for
        // admins. Default RBAC blocks salesmen from Analytics — this is
        // defence-in-depth for the direct sales aggregations.
        const _spId = req.user && req.user.sub;
        const sp = (q, col) => (req.isSalesman ? q.where(col, _spId) : q);

        // Anchor the rolling 12-month window on the LATEST transaction so a set of
        // historical books (e.g. an imported FY2022-23) still populates the trend +
        // cash-flow charts instead of showing 12 empty months from today.
        const [invAnchor, payAnchor] = await Promise.all([
            sp(db('invoices').where({ company_id: companyId, type: 'sales' }).whereNull('deleted_at'), 'created_by').max('invoice_date as d').first(),
            db('payments').where({ company_id: companyId }).whereNull('deleted_at').max('payment_date as d').first(),
        ]);
        let anchor = new Date();
        const cand = [invAnchor && invAnchor.d, payAnchor && payAnchor.d].filter(Boolean).map((x) => new Date(x));
        if (cand.length) {
            const latest = new Date(Math.max(...cand.map((d) => d.getTime())));
            if (latest < anchor) anchor = latest;   // books are historical → walk the window back to them
        }
        const winStart = new Date(anchor.getFullYear(), anchor.getMonth() - 11, 1);
        const winStartStr = `${winStart.getFullYear()}-${String(winStart.getMonth() + 1).padStart(2, '0')}-01`;
        const monthStart = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-01`;

        const [
            totalSalesRow, salesThisMonthRow, totalReceiptsRow,
            salesByMonth, receiptsByMonth, paymentsByMonth,
            topCustomers, topProducts, custBalances,
        ] = await Promise.all([
            sp(db('invoices').where({ company_id: companyId, type: 'sales' }).whereNull('deleted_at'), 'created_by').sum('total as s').first(),
            sp(db('invoices').where({ company_id: companyId, type: 'sales' }).whereNull('deleted_at'), 'created_by').where('invoice_date', '>=', monthStart).sum('total as s').first(),
            db('payments').where({ company_id: companyId, type: 'receipt' }).whereNull('deleted_at').sum('amount as s').first(),

            sp(db('invoices').where({ company_id: companyId, type: 'sales' }).whereNull('deleted_at'), 'created_by')
                .where('invoice_date', '>=', winStartStr)
                .select(db.raw("date_trunc('month', invoice_date) as m")).sum('total as s')
                .groupByRaw("date_trunc('month', invoice_date)"),

            db('payments').where({ company_id: companyId, type: 'receipt' }).whereNull('deleted_at')
                .where('payment_date', '>=', winStartStr)
                .select(db.raw("date_trunc('month', payment_date) as m")).sum('amount as s')
                .groupByRaw("date_trunc('month', payment_date)"),

            db('payments').where({ company_id: companyId, type: 'payment' }).whereNull('deleted_at')
                .where('payment_date', '>=', winStartStr)
                .select(db.raw("date_trunc('month', payment_date) as m")).sum('amount as s')
                .groupByRaw("date_trunc('month', payment_date)"),

            sp(db('invoices as i').leftJoin('customers as c', 'c.id', 'i.customer_id')
                .where('i.company_id', companyId).where('i.type', 'sales').whereNull('i.deleted_at')
                .whereNotNull('i.customer_id'), 'i.created_by')
                .select('c.name as name').sum('i.total as total')
                .groupBy('c.id', 'c.name').orderBy('total', 'desc').limit(5),

            sp(db('invoice_items as it').join('invoices as i', 'i.id', 'it.invoice_id')
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .where('i.company_id', companyId).where('i.type', 'sales').whereNull('i.deleted_at'), 'i.created_by')
                // Fall back to the line description when a line isn't linked to a
                // product (Tally free-text / unsynced items) so top-sellers still show.
                .select(db.raw("coalesce(nullif(p.name, ''), nullif(it.description, '')) as name")).sum('it.amount as value').sum('it.quantity as qty')
                .groupByRaw("coalesce(nullif(p.name, ''), nullif(it.description, ''))")
                .havingRaw("coalesce(nullif(p.name, ''), nullif(it.description, '')) is not null")
                .orderBy('value', 'desc').limit(5),

            // Per-customer outstanding + oldest overdue bill (for aging).
            db('customers as c').where('c.company_id', companyId).whereNull('c.deleted_at').select(
                'c.opening_balance',
                db.raw("coalesce((select sum(i.total) from invoices i where i.customer_id = c.id and i.type = 'sales' and i.deleted_at is null), 0) as sales_total"),
                db.raw("coalesce((select sum(p.amount) from payments p where p.customer_id = c.id and p.type = 'receipt' and p.deleted_at is null), 0) as receipts_total"),
                db.raw("(select min(i.due_date) from invoices i where i.customer_id = c.id and i.type = 'sales' and i.deleted_at is null and i.due_date is not null and i.due_date < current_date) as oldest_due"),
            ),
        ]);

        const { labels, keys } = build12Months(anchor);
        const sales_trend = { labels, data: fillMonthly(salesByMonth, keys) };
        const cashflow = { labels, inflow: fillMonthly(receiptsByMonth, keys), outflow: fillMonthly(paymentsByMonth, keys) };
        const top_customers = topCustomers.filter((x) => x.name).map((x) => ({ name: x.name, total: num(x.total) }));
        const top_products = topProducts.filter((x) => x.name).map((x) => ({ name: x.name, value: num(x.value), qty: num(x.qty) }));

        // Receivables aging — each customer's outstanding falls in the bucket of
        // their OLDEST overdue bill's age (current/not-overdue → 0-30).
        const now = new Date();
        const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
        let totalReceivable = 0;
        for (const c of custBalances) {
            const out = num(c.opening_balance) + num(c.sales_total) - num(c.receipts_total);
            if (out <= 0.5) continue;
            totalReceivable += out;
            const days = c.oldest_due ? Math.max(0, Math.floor((now - new Date(c.oldest_due)) / 86400000)) : 0;
            const bucket = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
            aging[bucket] += out;
        }
        const agingArr = Object.entries(aging).map(([label, amount]) => ({ label, amount: r2(amount) }));

        const kpis = {
            total_sales:      num(totalSalesRow && totalSalesRow.s),
            sales_this_month: num(salesThisMonthRow && salesThisMonthRow.s),
            total_receipts:   num(totalReceiptsRow && totalReceiptsRow.s),
            total_receivable: r2(totalReceivable),
            top_customer:     top_customers[0] ? top_customers[0].name : null,
        };

        return R.successResponse(res, { kpis, sales_trend, cashflow, top_customers, top_products, aging: agingArr });
    } catch (err) {
        console.error('analytics.overview error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { overview };
