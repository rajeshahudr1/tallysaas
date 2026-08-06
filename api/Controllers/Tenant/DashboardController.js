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
 *     deltas: {            // real previous-period comparisons — see pctChange().
 *       today_sales,       // vs yesterday
 *       invoice_amount, payment_received,  // vs the previous equal-length
 *                          //   period; ABSENT with no ?from/?to range
 *       customers, products, companies,    // vs the running total before
 *                          //   this month began (created_at)
 *                          // pending_sync / stock_value: no history stored
 *                          //   anywhere → no key here at all, ever.
 *       // each entry: { dir: 'up'|'down'|'flat', pct: number|null, caption }
 *     },
 *     balances: {          // point-in-time, NOT affected by ?from/?to
 *       cash,              // Σ tally_ledgers.closing_balance under Cash-in-hand
 *       bank,              // …under Bank Accounts + Bank OD A/c
 *       payables           // …under Sundry Creditors, absolute value
 *     },
 *     attention: {
 *       inactive_customers,  // no sales invoice in the last 90 days
 *       inactive_stocks,     // not on any sales invoice line in 90 days
 *       missing_mobile, missing_email,   // customers lacking contact details
 *       overdue_count, overdue_amount    // sales invoices past due_date
 *     },
 *     sales_receipt: {     // Sales & Receipt panel
 *       labels, sales[], receipt[],        // 12-month grouped-bar series
 *       total_sales, total_receipt,        // range-scoped headline figures
 *       sales_this_month, receipt_this_month,
 *       sales_change_pct, receipt_change_pct   // vs last month; null if no base
 *     },
 *     receivables: {       // Receivables panel — FIFO-allocated, see
 *                          // Helpers/receivablesAgeing
 *       total, overdue, projection_15, projection_60,
 *       buckets: [{ label, amount }] x6    // 0-45 … >225 days
 *     },
 *     top10: {             // six leaderboards, 10 rows each
 *       customers[], suppliers[],           // { name, value, dc } — Dr / Cr
 *       items_sold_qty[], items_sold_value[],
 *       items_purchased_qty[], items_purchased_value[]   // { name, value, qty }
 *     },
 *     day_book: [{ kind, voucher_no, particulars, type, amount }],
 *     day_book_date: 'YYYY-MM-DD',   // echoes ?daybook=, else today
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
const { sumBalances } = require('../../Helpers/ledgerGroups');
const { BUCKETS, buildReceivables, buildReceivablesRows } = require('../../Helpers/receivablesAgeing');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// Alert windows for the "Need Attention" panel. A customer/product is
// "inactive" when it has had no sales activity in this many days.
const INACTIVE_DAYS = 90;

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

// 'YYYY-MM-DD' for N days before today — the inactivity cutoff.
function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today as 'YYYY-MM-DD' — the overdue cutoff.
function today() {
    return daysAgo(0);
}

/**
 * pctChange(current, previous) — a pure percentage-change calculator shared
 * by every stat that gets a real previous-period figure. Never invents a
 * number: a rise FROM ZERO has no percentage (it would be either "+Infinity%"
 * or a meaningless "+100%"), so `pct` comes back null and only the direction
 * arrow is reported. Rounded to one decimal so captions stay readable
 * ("+15.1%" not "+15.099999999999998%").
 */
function pctChange(current, previous) {
    const curr = Number(current || 0);
    const prev = Number(previous || 0);
    if (prev === 0) {
        if (curr === 0) return { dir: 'flat', pct: 0 };
        return { dir: curr > 0 ? 'up' : 'down', pct: null };
    }
    const raw = ((curr - prev) / prev) * 100;
    const pct = Math.round(Math.abs(raw) * 10) / 10;
    const dir = curr === prev ? 'flat' : (curr > prev ? 'up' : 'down');
    return { dir, pct };
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

        // ?parts=summary,salesreceipt — compute ONLY the listed panels. The web
        // dashboard re-renders one panel at a time over AJAX, and running all
        // ~36 aggregates (bill-wise ageing, four item leaderboards, two
        // anti-joins) for a panel that needs three of them is what made a
        // single range change take seconds. Omit the param → everything runs,
        // which is what the full page render still does.
        const parts = String(req.query.parts || '').trim()
            ? new Set(String(req.query.parts).toLowerCase().split(',')
                .map((s) => s.trim()).filter(Boolean))
            : null;
        const want = (p) => !parts || parts.has(p);
        // Pick the query only when its panel was asked for; otherwise hand back
        // an already-resolved empty value so the response shape never changes.
        const only = (p, q, empty) => (want(p) ? q : Promise.resolve(empty));

        // Per-user location scoping (Requirement C). A location-restricted user
        // sees ONLY their location's figures; unrestricted (locationId null) →
        // the whole company. `loc(qb, col)` adds the location filter when set and
        // is a no-op otherwise. Applied to the location-bearing tables ONLY —
        // customers, suppliers and invoices carry location_id; products, payments
        // and tally_sync_logs do NOT, so they stay company-wide.
        const locationId = req.locationId;
        const loc = (qb, col) => (locationId != null ? qb.where(col, locationId) : qb);
        // Field-sales scoping: a salesman's dashboard invoice metrics count ONLY
        // the invoices THEY created (mirrors the invoice list / report scoping).
        // Applied to the invoice queries via their created_by column.
        const mineId = req.isSalesman ? req.user.sub : null;
        const mine = (qb, col) => (mineId != null ? qb.where(col, mineId) : qb);

        // Optional dashboard date range (from the header date-range picker).
        // When both are valid YYYY-MM-DD (from ≤ to), the date-sensitive money
        // metrics + recent invoices scope to [from, to]; otherwise their
        // original defaults apply (today_sales = this month; rest = all-time).
        const from = parseDate(req.query.from);
        const to   = parseDate(req.query.to);
        const hasRange = !!(from && to && from <= to);

        const todaySalesQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed');
        loc(todaySalesQ, 'location_id');
        mine(todaySalesQ, 'created_by');
        if (hasRange) todaySalesQ.whereBetween('invoice_date', [from, to]);
        else todaySalesQ.where('invoice_date', '>=', monthStart);

        const invoiceAmountQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales');
        loc(invoiceAmountQ, 'location_id');
        mine(invoiceAmountQ, 'created_by');
        if (hasRange) invoiceAmountQ.whereBetween('invoice_date', [from, to]);

        // payments has NO location_id column → never location-filtered.
        const paymentReceivedQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt');
        if (hasRange) paymentReceivedQ.whereBetween('payment_date', [from, to]);

        // ── Delta sources (Task 1) ──────────────────────────────────────
        // Every number below is a genuine "one more query, shifted dates"
        // previous-period figure. Where a cheap previous value does not
        // exist (Pending Tally Sync, Stock Value — no history table), no
        // query is built at all and no delta is attached later.

        // Today's Sales — literal today vs literal yesterday (single day
        // each), same filters as the headline query, caption "vs yesterday".
        const todayOnlyQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed')
            .where('invoice_date', today());
        loc(todayOnlyQ, 'location_id');
        mine(todayOnlyQ, 'created_by');

        const yesterdayOnlyQ = db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed')
            .where('invoice_date', daysAgo(1));
        loc(yesterdayOnlyQ, 'location_id');
        mine(yesterdayOnlyQ, 'created_by');

        // Invoice Amount / Payment Received — only meaningful when a range is
        // actually selected (no range = all-time, which has no "previous
        // period" to compare against). The previous period is the same
        // length, immediately before the selected one.
        let prevFrom = null, prevTo = null;
        if (hasRange) {
            const rangeSpanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
            const prevToD = new Date(`${from}T00:00:00`);
            prevToD.setDate(prevToD.getDate() - 1);
            const prevFromD = new Date(prevToD);
            prevFromD.setDate(prevFromD.getDate() - (rangeSpanDays - 1));
            const pad3 = (n) => String(n).padStart(2, '0');
            const iso = (d) => `${d.getFullYear()}-${pad3(d.getMonth() + 1)}-${pad3(d.getDate())}`;
            prevFrom = iso(prevFromD);
            prevTo   = iso(prevToD);
        }

        const prevInvoiceAmountQ = hasRange
            ? mine(loc(db('invoices').where('company_id', companyId)
                .whereNull('deleted_at').where('type', 'sales')
                .whereBetween('invoice_date', [prevFrom, prevTo]), 'location_id'), 'created_by')
                .sum('total as s').first()
            : Promise.resolve(null);

        const prevPaymentReceivedQ = hasRange
            ? db('payments').where('company_id', companyId)
                .whereNull('deleted_at').where('type', 'receipt')
                .whereBetween('payment_date', [prevFrom, prevTo])
                .sum('amount as s').first()
            : Promise.resolve(null);

        // Total Customers / Products / Companies — "this month vs the running
        // total as it stood before this month began", via created_at. Cheap:
        // one extra count per stat, no join, no history table needed.
        const customersBeforeThisMonthQ = loc(db('customers')
            .where('company_id', companyId).whereNull('deleted_at')
            .where('created_at', '<', monthStart), 'location_id')
            .count('id as c').first();

        const productsBeforeThisMonthQ = db('products')
            .where('company_id', companyId).whereNull('deleted_at')
            .where('created_at', '<', monthStart)
            .count('id as c').first();

        const companiesBeforeThisMonthQ = db('companies')
            .whereNull('deleted_at').where('created_at', '<', monthStart)
            .count('id as c').first();

        const recentInvoicesQ = db('invoices')
            .leftJoin('customers', 'customers.id', 'invoices.customer_id')
            .where('invoices.company_id', companyId)
            .whereNull('invoices.deleted_at')
            .where('invoices.type', 'sales');
        loc(recentInvoicesQ, 'invoices.location_id');
        mine(recentInvoicesQ, 'invoices.created_by');
        if (hasRange) recentInvoicesQ.whereBetween('invoices.invoice_date', [from, to]);
        recentInvoicesQ.orderBy('invoices.id', 'desc').limit(6).select(
            'invoices.invoice_no',
            'customers.name as customer',
            'invoices.total',
            'invoices.status',
            'invoices.invoice_date',
        );

        const cutoff = daysAgo(INACTIVE_DAYS);

        // Inactive customers — live customers with NO sales invoice dated on or
        // after the cutoff. `whereNotExists` (rather than a LEFT JOIN + GROUP BY)
        // keeps this a single index-friendly anti-join.
        const inactiveCustomersQ = loc(db('customers')
            .where('customers.company_id', companyId)
            .whereNull('customers.deleted_at'), 'customers.location_id')
            .whereNotExists(function () {
                this.select(db.raw('1')).from('invoices')
                    .whereRaw('invoices.customer_id = customers.id')
                    .whereNull('invoices.deleted_at')
                    .where('invoices.type', 'sales')
                    .where('invoices.invoice_date', '>=', cutoff);
            })
            .count('customers.id as c').first();

        // Inactive stocks — live products not appearing on any sales invoice
        // line dated on or after the cutoff. products carry no location_id.
        const inactiveStocksQ = db('products')
            .where('products.company_id', companyId)
            .whereNull('products.deleted_at')
            .whereNotExists(function () {
                this.select(db.raw('1')).from('invoice_items')
                    .join('invoices', 'invoices.id', 'invoice_items.invoice_id')
                    .whereRaw('invoice_items.product_id = products.id')
                    .whereNull('invoices.deleted_at')
                    .where('invoices.type', 'sales')
                    .where('invoices.invoice_date', '>=', cutoff);
            })
            .count('products.id as c').first();

        // Missing contact details — customers with no mobile / no email.
        // A blank string counts as missing, not just NULL.
        const missingContactQ = loc(db('customers')
            .where('company_id', companyId)
            .whereNull('deleted_at'), 'location_id')
            .select(
                db.raw("count(*) FILTER (WHERE coalesce(trim(mobile), '') = '') as mobile"),
                db.raw("count(*) FILTER (WHERE coalesce(trim(email),  '') = '') as email"),
            ).first();

        // Overdue invoices — sales invoices whose due date has passed.
        // NOTE: payments are recorded against a PARTY, not an invoice, so we
        // cannot net off partial receipts here; this is a due-date-based count.
        const overdueQ = mine(loc(db('invoices')
            .where('company_id', companyId)
            .whereNull('deleted_at')
            .where('type', 'sales')
            .whereNot('status', 'failed')
            .whereNotNull('due_date')
            .where('due_date', '<', today()), 'location_id'), 'created_by')
            .select(db.raw('count(*) as c'), db.raw('coalesce(sum(total), 0) as s'))
            .first();

        // Ledger tree — two flat SELECTs, rolled up in memory by sumBalances.
        // No location_id on these; deleted_at IS present (tenant migration 001)
        // and must be excluded — the reconcile pass soft-deletes what Tally
        // dropped, so counting those would inflate every dashboard total.
        // With a period selected the tiles must read AS ON its last date, not
        // "as of the last sync": each ledger's balance is replayed as
        // opening_balance + Σ signed postings up to `to`. Postings key on
        // ledger_name (Tally's own identity for a ledger), and Tally stores a
        // debit NEGATIVE — hence the re-signing from is_debit, matching
        // Helpers/ledgerBalance. Without a range we keep the cheap snapshot,
        // which is the same number as "as on today".
        const ledgersQ = hasRange
            ? db('tally_ledgers as l')
                .where('l.company_id', companyId).whereNull('l.deleted_at')
                .leftJoin(
                    db('tally_voucher_entries')
                        .where('company_id', companyId)
                        .where('voucher_date', '<=', to)
                        .select('ledger_name')
                        .sum({ moved: db.raw('case when is_debit then abs(amount) else -abs(amount) end') })
                        .groupBy('ledger_name')
                        .as('mv'),
                    'mv.ledger_name', 'l.name',
                )
                .select('l.parent', db.raw('(coalesce(l.opening_balance, 0) + coalesce(mv.moved, 0)) as closing_balance'))
            : db('tally_ledgers').where('company_id', companyId)
                .whereNull('deleted_at')
                .select('parent', 'closing_balance');
        const groupsQ = db('tally_groups').where('company_id', companyId)
            .whereNull('deleted_at')
            .select('name', 'parent', 'primary_group');

        // ── Sales & Receipt panel ───────────────────────────────────────
        // The chart follows the SELECTED period, not a fixed rolling year:
        // pick "Today" and you get today, pick "This Year" and you get its
        // twelve months. A short window (≤ 92 days) is bucketed by DAY so a
        // single day is not drawn as one lonely monthly bar; anything longer
        // stays monthly. With no range at all we keep the rolling 12 months.
        const dayMs = 86400000;
        const rangeDays = hasRange
            ? Math.round((new Date(to) - new Date(from)) / dayMs) + 1 : null;
        // Whitelisted, never interpolated from user input.
        const grain = (hasRange && rangeDays <= 92) ? 'day' : 'month';
        const trunc = (col) => `date_trunc('${grain}', ${col})`;

        const salesSeriesQ = mine(loc(db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales')
            .whereNot('status', 'failed'), 'location_id'), 'created_by');
        if (hasRange) salesSeriesQ.whereBetween('invoice_date', [from, to]);
        else salesSeriesQ.where('invoice_date', '>=',
            db.raw("date_trunc('month', now()) - interval '11 months'"));
        salesSeriesQ
            .select(db.raw(`${trunc('invoice_date')} as m`))
            .sum('total as s')
            .groupByRaw(trunc('invoice_date'));

        // Receipts bucketed to the same axis as sales. payments has no
        // location_id, so this stays company-wide (same as payment_received).
        const receiptsByMonthQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt');
        if (hasRange) receiptsByMonthQ.whereBetween('payment_date', [from, to]);
        else receiptsByMonthQ.where('payment_date', '>=',
            db.raw("date_trunc('month', now()) - interval '11 months'"));
        receiptsByMonthQ
            .select(db.raw(`${trunc('payment_date')} as m`))
            .sum('amount as s')
            .groupByRaw(trunc('payment_date'));

        // This-month / last-month totals for the panel footer's delta captions.
        // Independent of the ?from/?to range — the footer always compares the
        // two most recent calendar months, exactly like the reference.
        const monthPairSalesQ = mine(loc(db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed')
            .where('invoice_date', '>=', db.raw("date_trunc('month', now()) - interval '1 month'")), 'location_id'), 'created_by')
            .select(db.raw("date_trunc('month', invoice_date) as m")).sum('total as s')
            .groupByRaw("date_trunc('month', invoice_date)");

        const monthPairReceiptQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt')
            .where('payment_date', '>=', db.raw("date_trunc('month', now()) - interval '1 month'"))
            .select(db.raw("date_trunc('month', payment_date) as m")).sum('amount as s')
            .groupByRaw("date_trunc('month', payment_date)");

        // ── Receivables panel ───────────────────────────────────────────
        // Every open sales invoice + every receipt, allocated FIFO per customer
        // in the API (payments reference a party, not an invoice — see
        // Helpers/receivablesAgeing). Only rows with a customer participate:
        // a receivable with no party cannot be aged against anyone.
        const openInvoicesQ = mine(loc(db('invoices').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'sales').whereNot('status', 'failed')
            .whereNotNull('customer_id'), 'location_id'), 'created_by')
            .select('customer_id', 'invoice_date', 'due_date', 'total');

        const customerReceiptsQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt')
            .whereNotNull('customer_id')
            .select('customer_id').sum('amount as amount')
            .groupBy('customer_id');

        // ── Top 10 panel ────────────────────────────────────────────────
        // Parties are ranked by OUTSTANDING balance (what they owe / we owe),
        // matching the reference's "Dr" / "Cr" figures — not by turnover.
        // Billed minus settled, computed with correlated sub-selects so each
        // party needs one row rather than a join fan-out.
        // Billed and settled are pre-aggregated ONCE per party and joined, NOT
        // computed with correlated sub-selects per row: with a few thousand
        // parties and no index on invoices.customer_id, the correlated form
        // re-scanned invoices + payments per customer and took ~3.5s on its
        // own — it was the single slowest thing on the dashboard. Grouped +
        // joined it is ~50ms on the same data.
        const billedTo = (partyCol, invType) => db('invoices')
            .where('company_id', companyId).whereNull('deleted_at')
            .where('type', invType).whereNot('status', 'failed')
            .whereNotNull(partyCol)
            .select(partyCol).sum('total as billed').groupBy(partyCol);

        const settledBy = (partyCol, payType) => db('payments')
            .where('company_id', companyId).whereNull('deleted_at')
            .where('type', payType).whereNotNull(partyCol)
            .select(partyCol).sum('amount as settled').groupBy(partyCol);

        const topCustomersQ = loc(db('customers as c')
            .where('c.company_id', companyId).whereNull('c.deleted_at'), 'c.location_id')
            .leftJoin(billedTo('customer_id', 'sales').as('bi'), 'bi.customer_id', 'c.id')
            .leftJoin(settledBy('customer_id', 'receipt').as('pa'), 'pa.customer_id', 'c.id')
            .select('c.name')
            .select(db.raw('(coalesce(bi.billed, 0) - coalesce(pa.settled, 0)) as balance'))
            .orderBy('balance', 'desc').limit(10);

        const topSuppliersQ = loc(db('suppliers as s')
            .where('s.company_id', companyId).whereNull('s.deleted_at'), 's.location_id')
            .leftJoin(billedTo('supplier_id', 'purchase').as('bi'), 'bi.supplier_id', 's.id')
            .leftJoin(settledBy('supplier_id', 'payment').as('pa'), 'pa.supplier_id', 's.id')
            .select('s.name')
            .select(db.raw('(coalesce(bi.billed, 0) - coalesce(pa.settled, 0)) as balance'))
            .orderBy('balance', 'desc').limit(10);

        // Item leaderboards. One builder, four orderings — sold vs purchased
        // (the invoice type) × by quantity vs by value.
        const topItems = (invType, orderCol) => db('invoice_items as ii')
            .join('invoices as i', 'i.id', 'ii.invoice_id')
            .leftJoin('products as p', 'p.id', 'ii.product_id')
            .where('i.company_id', companyId)
            .whereNull('i.deleted_at')
            .where('i.type', invType)
            .whereNot('i.status', 'failed')
            .select(db.raw('coalesce(p.name, ii.description) as name'))
            .sum('ii.quantity as qty')
            .sum('ii.amount as value')
            .groupByRaw('coalesce(p.name, ii.description)')
            .orderBy(orderCol, 'desc')
            .limit(10);

        const itemsSoldQtyQ      = topItems('sales', 'qty');
        const itemsSoldValueQ    = topItems('sales', 'value');
        const itemsBoughtQtyQ    = topItems('purchase', 'qty');
        const itemsBoughtValueQ  = topItems('purchase', 'value');

        // ── Day Book panel ──────────────────────────────────────────────
        // One day's vouchers across the three transaction tables, merged and
        // sorted in JS (they have no common table to UNION cheaply through
        // Knex, and a day's traffic is small).
        const bookDate = parseDate(req.query.daybook) || today();

        const dayInvoicesQ = mine(loc(db('invoices as i')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .leftJoin('suppliers as s', 's.id', 'i.supplier_id')
            .where('i.company_id', companyId)
            .whereNull('i.deleted_at')
            .where('i.invoice_date', bookDate), 'i.location_id'), 'i.created_by')
            .select('i.id', 'i.invoice_no as voucher_no', 'i.type', 'i.total as amount',
                db.raw('coalesce(c.name, s.name) as particulars'));

        const dayPaymentsQ = db('payments as p')
            .leftJoin('customers as c', 'c.id', 'p.customer_id')
            .leftJoin('suppliers as s', 's.id', 'p.supplier_id')
            .where('p.company_id', companyId)
            .whereNull('p.deleted_at')
            .where('p.payment_date', bookDate)
            .select('p.id', 'p.voucher_no', 'p.type', 'p.amount',
                db.raw('coalesce(c.name, s.name) as particulars'));

        const dayJournalsQ = db('journals')
            .where('company_id', companyId)
            .whereNull('deleted_at')
            .where('journal_date', bookDate)
            .select('id', 'voucher_no', 'vch_type', 'amount', 'dr_ledger', 'cr_ledger');

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
            inactiveCustomersRow,
            inactiveStocksRow,
            missingContactRow,
            overdueRow,
            ledgerRows,
            groupRows,
            receiptsByMonth,
            monthPairSales,
            monthPairReceipt,
            openInvoices,
            customerReceipts,
            topCustomers,
            topSuppliers,
            itemsSoldQty,
            itemsSoldValue,
            itemsBoughtQty,
            itemsBoughtValue,
            dayInvoices,
            dayPayments,
            dayJournals,
            todayOnlyRow,
            yesterdayOnlyRow,
            prevInvoiceAmountRow,
            prevPaymentReceivedRow,
            customersBeforeThisMonthRow,
            productsBeforeThisMonthRow,
            companiesBeforeThisMonthRow,
        ] = await Promise.all([
            // ── counts ──────────────────────────────────────────────
            only('summary', db('companies').whereNull('deleted_at').count('id as c').first(), {}),

            only('summary', loc(db('customers').where('company_id', companyId)
                .whereNull('deleted_at'), 'location_id').count('id as c').first(), {}),

            // products has NO location_id → company-wide count always.
            only('summary', db('products').where('company_id', companyId)
                .whereNull('deleted_at').count('id as c').first(), {}),

            only('summary', loc(db('suppliers').where('company_id', companyId)
                .whereNull('deleted_at'), 'location_id').count('id as c').first(), {}),

            // today_sales — sales total for the selected range (else this month).
            only('summary', todaySalesQ.sum('total as s').first(), {}),

            // pending_sync parts (summed below).
            only('summary', loc(db('customers').where('company_id', companyId)
                .whereNull('deleted_at').whereNull('tally_guid'), 'location_id')
                .count('id as c').first(), {}),

            only('summary', db('products').where('company_id', companyId)
                .whereNull('deleted_at').whereNull('tally_guid')
                .count('id as c').first(), {}),

            only('summary', mine(loc(db('invoices').where('company_id', companyId)
                .whereNull('deleted_at').where('status', 'pending_tally'), 'location_id'), 'created_by')
                .count('id as c').first(), {}),

            only('summary', db('payments').where('company_id', companyId)
                .whereNull('deleted_at').where('status', 'pending_tally')
                .count('id as c').first(), {}),

            // stock_value — Σ sales_price * opening_stock over live products.
            only('summary', db('products').where('company_id', companyId)
                .whereNull('deleted_at')
                .sum(db.raw('sales_price * opening_stock')).first(), {}),

            // invoice_amount — Σ total over sales invoices (range-scoped).
            only('salesreceipt', invoiceAmountQ.sum('total as s').first(), {}),

            // payment_received — Σ amount over receipt vouchers (range-scoped).
            only('salesreceipt', paymentReceivedQ.sum('amount as s').first(), {}),

            // ── sales_chart — sales totals on the SELECTED period's axis ──
            only('salesreceipt', salesSeriesQ, []),

            // ── sync_chart — synced / failed log counts (pending computed below) ──
            only('summary', db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'synced').count('id as c').first(), {}),

            only('summary', db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'failed').count('id as c').first(), {}),

            // ── recent_invoices — last 6 sales invoices (range-scoped) ──
            only('summary', recentInvoicesQ, []),

            // ── recent_sync — last 6 sync log entries ──
            only('summary', db('tally_sync_logs').where('company_id', companyId)
                .orderBy('id', 'desc')
                .limit(6)
                .select('module', 'record_type', 'record_id', 'status', 'created_at'), []),

            // ── Need Attention aggregates + the ledger tree ──────────────
            only('summary', inactiveCustomersQ, {}),
            only('summary', inactiveStocksQ, {}),
            only('summary', missingContactQ, {}),
            only('summary', overdueQ, {}),
            only('summary', ledgersQ, []),
            only('summary', groupsQ, []),

            // ── Sales & Receipt + Receivables panels ─────────────────────
            only('salesreceipt', receiptsByMonthQ, []),
            only('salesreceipt', monthPairSalesQ, []),
            only('salesreceipt', monthPairReceiptQ, []),
            only('receivables', openInvoicesQ, []),
            only('receivables', customerReceiptsQ, []),

            // ── Top 10 + Day Book panels ────────────────────────────────
            only('top10', topCustomersQ, []),
            only('top10', topSuppliersQ, []),
            only('top10', itemsSoldQtyQ, []),
            only('top10', itemsSoldValueQ, []),
            only('top10', itemsBoughtQtyQ, []),
            only('top10', itemsBoughtValueQ, []),
            only('daybook', dayInvoicesQ, []),
            only('daybook', dayPaymentsQ, []),
            only('daybook', dayJournalsQ, []),

            // ── Delta sources (Task 1) — only when the 'summary'/'salesreceipt'
            // panel that renders them was actually requested. ─────────────
            only('summary', todayOnlyQ.sum('total as s').first(), {}),
            only('summary', yesterdayOnlyQ.sum('total as s').first(), {}),
            only('salesreceipt', prevInvoiceAmountQ, null),
            only('salesreceipt', prevPaymentReceivedQ, null),
            only('summary', customersBeforeThisMonthQ, {}),
            only('summary', productsBeforeThisMonthQ, {}),
            only('summary', companiesBeforeThisMonthQ, {}),
        ]);

        // pending_sync — sum of the four pending buckets.
        const pendingSync =
            num(pendingCustomersRow && pendingCustomersRow.c) +
            num(pendingProductsRow  && pendingProductsRow.c) +
            num(pendingInvoicesRow  && pendingInvoicesRow.c) +
            num(pendingPaymentsRow  && pendingPaymentsRow.c);

        // Chart axis — every slot the SELECTED period covers, oldest → newest,
        // at the grain the queries were bucketed to. Gaps stay 0 so a quiet day
        // shows an empty slot rather than shifting the series along.
        const now    = new Date();
        const labels = [];
        const buckets = [];   // bucket keys aligned with labels
        const pad2 = (n) => String(n).padStart(2, '0');
        const dayKey   = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const monthKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

        if (grain === 'day') {
            const start = parseDate(from) ? new Date(`${from}T00:00:00`) : now;
            const end   = parseDate(to)   ? new Date(`${to}T00:00:00`)   : now;
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                labels.push(`${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`);
                buckets.push(dayKey(d));
            }
        } else if (hasRange) {
            const start = new Date(`${from}T00:00:00`);
            const end   = new Date(`${to}T00:00:00`);
            const cur   = new Date(start.getFullYear(), start.getMonth(), 1);
            while (cur <= end) {
                labels.push(MONTH_NAMES[cur.getMonth()]);
                buckets.push(monthKeyOf(cur));
                cur.setMonth(cur.getMonth() + 1);
            }
        } else {
            for (let i = 11; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                labels.push(MONTH_NAMES[d.getMonth()]);
                buckets.push(monthKeyOf(d));
            }
        }

        // Bucket key for a row's date_trunc value, at whatever grain is active.
        const bucketKey = (v) => {
            const d = new Date(v);
            return grain === 'day' ? dayKey(d) : monthKeyOf(d);
        };

        const salesMap = {};
        for (const row of salesByMonth) salesMap[bucketKey(row.m)] = num(row.s);
        const salesData = buckets.map((key) => salesMap[key] || 0);

        // sales_receipt — the same axis with a second (receipt) series, plus the
        // footer's this-month/last-month comparison (always calendar months).
        const monthKey = (v) => monthKeyOf(new Date(v));
        const receiptMap = {};
        for (const row of receiptsByMonth) receiptMap[bucketKey(row.m)] = num(row.s);
        const receiptData = buckets.map((key) => receiptMap[key] || 0);

        // The footer always compares the two most recent CALENDAR months, so it
        // is derived from today — not from the chart axis, which now follows the
        // selected period and may be bucketed by day.
        const thisKey = monthKeyOf(new Date(now.getFullYear(), now.getMonth(), 1));
        const lastKey = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const pick = (rows, key, col) => {
            for (const r of rows) if (monthKey(r.m) === key) return num(r[col]);
            return 0;
        };
        // Percentage change vs last month. With no base to compare against we
        // report null rather than a meaningless 100% — the view then hides the
        // caption instead of claiming a swing that did not happen.
        const pct = (curr, prev) => (prev > 0 ? ((curr - prev) / prev) * 100 : null);

        const salesThisMonth   = pick(monthPairSales,   thisKey, 's');
        const salesLastMonth   = pick(monthPairSales,   lastKey, 's');
        const receiptThisMonth = pick(monthPairReceipt, thisKey, 's');
        const receiptLastMonth = pick(monthPairReceipt, lastKey, 's');

        const sales_receipt = {
            labels,
            sales:   salesData,
            receipt: receiptData,
            total_sales:   num(invoiceAmountRow && invoiceAmountRow.s),
            total_receipt: num(paymentReceivedRow && paymentReceivedRow.s),
            sales_this_month:     salesThisMonth,
            receipt_this_month:   receiptThisMonth,
            sales_change_pct:     pct(salesThisMonth, salesLastMonth),
            receipt_change_pct:   pct(receiptThisMonth, receiptLastMonth),
        };

        // receivables — FIFO-allocated ageing over every open sales invoice.
        const receivables = buildReceivables(openInvoices, customerReceipts, now);

        // top10 — six leaderboards. Parties carry a Dr/Cr marker (a customer
        // balance is receivable = Dr, a supplier balance is payable = Cr) and
        // only settled-up parties (balance <= 0) are dropped.
        const party = (rows, dc) => (rows || [])
            .map((r) => ({ name: r.name, value: num(r.balance), dc }))
            .filter((r) => r.value > 0);

        const items = (rows) => (rows || []).map((r) => ({
            name:  r.name || '—',
            value: num(r.value),
            qty:   num(r.qty),
        }));

        const top10 = {
            customers:              party(topCustomers, 'Dr'),
            suppliers:              party(topSuppliers, 'Cr'),
            items_sold_qty:         items(itemsSoldQty),
            items_sold_value:       items(itemsSoldValue),
            items_purchased_qty:    items(itemsBoughtQty),
            items_purchased_value:  items(itemsBoughtValue),
        };

        // day_book — the three voucher sources merged into one list. `kind`
        // tells the web tier which module a row belongs to so it can build the
        // right drill-down link.
        const VOUCHER_LABEL = {
            sales: 'Sales', purchase: 'Purchase',
            receipt: 'Receipt', payment: 'Payment',
        };
        const day_book = [
            ...dayInvoices.map((r) => ({
                kind:        r.type === 'purchase' ? 'purchase-invoice' : 'sales-invoice',
                voucher_no:  r.voucher_no || '',
                particulars: r.particulars || '—',
                type:        VOUCHER_LABEL[r.type] || r.type,
                amount:      num(r.amount),
            })),
            ...dayPayments.map((r) => ({
                kind:        'payment',
                voucher_no:  r.voucher_no || '',
                particulars: r.particulars || '—',
                type:        VOUCHER_LABEL[r.type] || r.type,
                amount:      num(r.amount),
            })),
            ...dayJournals.map((r) => ({
                kind:        'journal',
                voucher_no:  r.voucher_no || '',
                // A journal has no party — name both sides instead, which is
                // what the ledger pair actually means to the reader.
                particulars: [r.dr_ledger, r.cr_ledger].filter(Boolean).join(' / ') || '—',
                type:        r.vch_type || 'Journal',
                amount:      num(r.amount),
            })),
        ].sort((a, b) => b.amount - a.amount);

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

        // ── Real deltas (Task 1) — attached ONLY where a genuine previous
        // value exists. A stat with no cheap previous figure (pending_sync,
        // stock_value — no history table) simply gets no `delta` key at all,
        // so the view renders no trend for it rather than inventing one.
        const deltas = {};

        // Today's Sales — literal today vs literal yesterday.
        deltas.today_sales = {
            ...pctChange(num(todayOnlyRow && todayOnlyRow.s), num(yesterdayOnlyRow && yesterdayOnlyRow.s)),
            caption: 'vs yesterday',
        };

        // Invoice Amount / Payment Received — only when a date range was
        // actually selected; "all-time" has no previous period to compare.
        if (hasRange) {
            deltas.invoice_amount = {
                ...pctChange(counts.invoice_amount, num(prevInvoiceAmountRow && prevInvoiceAmountRow.s)),
                caption: 'vs last period',
            };
            deltas.payment_received = {
                ...pctChange(counts.payment_received, num(prevPaymentReceivedRow && prevPaymentReceivedRow.s)),
                caption: 'vs last period',
            };
        }

        // Total Customers / Products / Companies — running total now vs the
        // running total as it stood before this month began (created_at).
        deltas.customers = {
            ...pctChange(counts.customers, num(customersBeforeThisMonthRow && customersBeforeThisMonthRow.c)),
            caption: 'vs last month',
        };
        deltas.products = {
            ...pctChange(counts.products, num(productsBeforeThisMonthRow && productsBeforeThisMonthRow.c)),
            caption: 'vs last month',
        };
        deltas.companies = {
            ...pctChange(counts.companies, num(companiesBeforeThisMonthRow && companiesBeforeThisMonthRow.c)),
            caption: 'vs last month',
        };
        // pending_sync and stock_value: no history stored anywhere → no delta.

        // balances — Cash / Bank / Receivables / Payables. With a period picked
        // these read AS ON its last date (the ledger replay above); with none,
        // they are the last-sync snapshot.
        const balances = sumBalances(ledgerRows, groupRows);

        // Inventory and Payables are FINANCIAL-YEAR figures in Tally (closing
        // stock + creditors are reported per FY), so they answer only a full
        // 1 Apr → 31 Mar selection. Any shorter period — a day, a week, a
        // quarter — has no FY figure to show, and reporting the running total
        // there would silently mis-state it, so those tiles read ₹0. This
        // mirrors the reference dashboard exactly.
        const isFullFY = hasRange
            && /-04-01$/.test(String(from)) && /-03-31$/.test(String(to))
            && (Number(String(to).slice(0, 4)) - Number(String(from).slice(0, 4)) === 1);
        // The stock snapshot we hold is CURRENT, so it can only speak for the
        // FY that contains today; an older FY has no stock history to read.
        const todayIso = today();
        const inCurrentFY = isFullFY && String(from) <= todayIso && todayIso <= String(to);
        if (hasRange && !isFullFY) {
            balances.payables = 0;
            counts.stock_value = 0;
        } else if (isFullFY && !inCurrentFY) {
            counts.stock_value = 0;
        }

        const attention = {
            inactive_customers: num(inactiveCustomersRow && inactiveCustomersRow.c),
            inactive_stocks:    num(inactiveStocksRow && inactiveStocksRow.c),
            missing_mobile:     num(missingContactRow && missingContactRow.mobile),
            missing_email:      num(missingContactRow && missingContactRow.email),
            overdue_count:      num(overdueRow && overdueRow.c),
            overdue_amount:     num(overdueRow && overdueRow.s),
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
            deltas,
            balances,
            attention,
            sales_receipt,
            receivables,
            top10,
            day_book,
            day_book_date: bookDate,
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

/**
 * GET /dashboard/receivables/bills — the individual open sales invoices
 * behind the Receivables panel's ageing doughnut, optionally narrowed to one
 * ?bucket= index (drill-down from the dashboard).
 *
 * Walks the EXACT same open-invoices + FIFO-receipts computation `summary`
 * feeds into buildReceivables() (Helpers/receivablesAgeing), so a bucket's
 * total here always equals what the dashboard shows for that bucket — see
 * buildReceivablesRows()'s own contract for why.
 *
 * Query:
 *   bucket    optional integer index into receivablesAgeing.BUCKETS (0-5).
 *             Omitted → every open invoice, any age.
 *   page, per_page  pagination (defaults 1 / 20, max 100).
 */
async function receivablesBills(req, res) {
    try {
        const companyId = req.companyId;

        let bucketIndex = null;
        if (req.query.bucket !== undefined && req.query.bucket !== '') {
            const n = Number(req.query.bucket);
            if (!Number.isInteger(n) || n < 0 || n >= BUCKETS.length) {
                return R.errorResponse(res, 'Invalid bucket.', 422);
            }
            bucketIndex = n;
        }

        let page = parseInt(req.query.page, 10);
        let perPage = parseInt(req.query.per_page, 10);
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(perPage) || perPage < 1) perPage = 20;
        if (perPage > 100) perPage = 100;

        // Same location + "my invoices" scoping as the dashboard panel itself
        // (Requirement C / SFA), so a location-restricted or salesman user
        // drilling into a bucket sees the same subset their dashboard totalled.
        const locationId = req.locationId;
        const loc = (qb, col) => (locationId != null ? qb.where(col, locationId) : qb);
        const mineId = req.isSalesman ? req.user.sub : null;
        const mine = (qb, col) => (mineId != null ? qb.where(col, mineId) : qb);

        const openInvoicesQ = mine(loc(db('invoices')
            .leftJoin('customers', 'customers.id', 'invoices.customer_id')
            .where('invoices.company_id', companyId)
            .whereNull('invoices.deleted_at').where('invoices.type', 'sales')
            .whereNot('invoices.status', 'failed')
            .whereNotNull('invoices.customer_id'), 'invoices.location_id'), 'invoices.created_by')
            .select(
                'invoices.id', 'invoices.invoice_no', 'invoices.customer_id',
                'customers.name as customer',
                'invoices.invoice_date', 'invoices.due_date', 'invoices.total',
            );

        const customerReceiptsQ = db('payments').where('company_id', companyId)
            .whereNull('deleted_at').where('type', 'receipt')
            .whereNotNull('customer_id')
            .select('customer_id').sum('amount as amount')
            .groupBy('customer_id');

        const [openInvoices, customerReceipts] = await Promise.all([openInvoicesQ, customerReceiptsQ]);

        let rows = buildReceivablesRows(openInvoices, customerReceipts, new Date());
        if (bucketIndex != null) rows = rows.filter((r) => r.bucket_index === bucketIndex);

        // Oldest first — the reference "which bills make up the ageing bucket"
        // reads most-overdue-first, and it makes every page's total_outstanding
        // add up to the header the same way whichever page you land on.
        rows.sort((a, b) => b.age_days - a.age_days);

        const total = rows.length;
        const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
        const paged = rows.slice((page - 1) * perPage, page * perPage);

        return R.successResponse(res, {
            data: paged.map((r) => ({
                id: r.id,
                invoice_no: r.invoice_no,
                customer: r.customer || '',
                invoice_date: r.invoice_date,
                due_date: r.due_date,
                outstanding: r.outstanding,
                age_days: r.age_days,
                bucket_index: r.bucket_index,
                bucket_label: r.bucket_label,
            })),
            meta: {
                total, page, per_page: perPage,
                total_outstanding: totalOutstanding,
                bucket_index: bucketIndex,
                bucket_label: bucketIndex != null ? BUCKETS[bucketIndex].label : null,
            },
        });
    } catch (err) {
        console.error('dashboard.receivablesBills error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { summary, receivablesBills, pctChange };
