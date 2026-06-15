'use strict';

/**
 * api/Controllers/Tenant/ReportController.js
 *
 * Read-only register/report endpoints. NOT wired through the crudController
 * factory — these are bespoke aggregate reads with summary totals computed over
 * the FULL filtered set (not just the returned page) and no writes.
 *
 *   salesRegister(req,res) — GET /reports/sales-register
 *     invoices type='sales', company-scoped, not soft-deleted, LEFT JOINed to
 *     customers for friendly customer / gstin labels. Optional filters
 *     ?date_from ?date_to (on invoice_date), ?status, ?customer_id. Returns:
 *       { summary: { count, total_taxable, total_gst, total_amount },
 *         data:    [{ date, invoice_no, customer, gstin, taxable, cgst, sgst,
 *                     total, status }],
 *         meta:    { total, page, per_page } }
 *     The summary aggregates run over the whole filtered set so the page-level
 *     `data` and the register totals stay consistent regardless of pagination.
 *
 * Conventions: company-scoped by req.companyId (resolveCompany), whereNull
 * deleted_at, every handler async + try/catch → console.error + 500 envelope.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE     = 100;

// Clamp/normalise pagination from the query string.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

// Coerce numeric(_,2) aggregate strings (knex returns them as strings) to a
// 2-decimal Number; NULL sums (no matching rows) collapse to 0.
function money(x) {
    return Number(Number(x || 0).toFixed(2));
}

/**
 * Build the shared, filtered base query for the sales register. The label join
 * to customers supplies `customer` / `gstin`; the caller layers select/order/
 * pagination (for the page) or aggregates (for the summary) on top.
 */
function buildBase(req) {
    let qb = db('invoices')
        .leftJoin('customers', 'customers.id', 'invoices.customer_id')
        .where('invoices.company_id', req.companyId)
        .where('invoices.type', 'sales')
        .whereNull('invoices.deleted_at');

    const status     = (req.query.status || '').trim();
    const customerId = req.query.customer_id;
    const dateFrom   = req.query.date_from;
    const dateTo     = req.query.date_to;

    if (status)     qb = qb.where('invoices.status', status);
    if (customerId) qb = qb.where('invoices.customer_id', customerId);
    if (dateFrom)   qb = qb.where('invoices.invoice_date', '>=', dateFrom);
    if (dateTo)     qb = qb.where('invoices.invoice_date', '<=', dateTo);

    return qb;
}

async function salesRegister(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);

        // Summary totals over the WHOLE filtered set — clone the base so the
        // aggregate query carries no select/order/limit from the page query.
        const summaryRow = await buildBase(req).clone()
            .clearSelect().clearOrder()
            .count('invoices.id as count')
            .sum('invoices.taxable as total_taxable')
            .sum('invoices.tax_amount as total_gst')
            .sum('invoices.total as total_amount')
            .first();

        const summary = {
            count:         Number(summaryRow ? summaryRow.count : 0),
            total_taxable: money(summaryRow ? summaryRow.total_taxable : 0),
            total_gst:     money(summaryRow ? summaryRow.total_gst : 0),
            total_amount:  money(summaryRow ? summaryRow.total_amount : 0),
        };

        // Page of rows.
        const rows = await buildBase(req)
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('invoices.invoice_date', 'desc')
            .orderBy('invoices.id', 'desc')
            .select(
                'invoices.invoice_date as date',
                'invoices.invoice_no as invoice_no',
                'customers.name as customer',
                'customers.gst_number as gstin',
                'invoices.taxable as taxable',
                'invoices.cgst as cgst',
                'invoices.sgst as sgst',
                'invoices.total as total',
                'invoices.status as status',
            );

        return R.successResponse(res, {
            summary,
            data: rows,
            meta: { total: summary.count, page, per_page: perPage },
        });
    } catch (err) {
        console.error('reports.salesRegister error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /reports/day-book — every voucher (sales/purchase invoices + receipts/
 * payments) for the company, newest first. Optional ?date_from ?date_to.
 */
async function dayBook(req, res) {
    try {
        const cid = req.companyId;
        const df = req.query.date_from, dt = req.query.date_to;

        let invQ = db('invoices')
            .leftJoin('customers', 'customers.id', 'invoices.customer_id')
            .leftJoin('suppliers', 'suppliers.id', 'invoices.supplier_id')
            .where('invoices.company_id', cid).whereNull('invoices.deleted_at');
        if (df) invQ = invQ.where('invoices.invoice_date', '>=', df);
        if (dt) invQ = invQ.where('invoices.invoice_date', '<=', dt);
        const invoices = await invQ.select(
            'invoices.invoice_date as date',
            db.raw("CASE WHEN invoices.type='purchase' THEN 'Purchase' ELSE 'Sales' END as vch_type"),
            'invoices.invoice_no as vch_no',
            db.raw('COALESCE(customers.name, suppliers.name) as party'),
            'invoices.total as amount',
        );

        let payQ = db('payments')
            .leftJoin('customers', 'customers.id', 'payments.customer_id')
            .leftJoin('suppliers', 'suppliers.id', 'payments.supplier_id')
            .where('payments.company_id', cid).whereNull('payments.deleted_at');
        if (df) payQ = payQ.where('payments.payment_date', '>=', df);
        if (dt) payQ = payQ.where('payments.payment_date', '<=', dt);
        const pays = await payQ.select(
            'payments.payment_date as date',
            db.raw("CASE WHEN payments.type='payment' THEN 'Payment' ELSE 'Receipt' END as vch_type"),
            'payments.voucher_no as vch_no',
            db.raw('COALESCE(customers.name, suppliers.name) as party'),
            'payments.amount as amount',
        );

        const sumBy = (arr, t) => money(arr.filter((x) => x.vch_type === t).reduce((s, x) => s + Number(x.amount || 0), 0));
        const rows = [...invoices, ...pays]
            .map((r) => ({ date: r.date, vch_type: r.vch_type, vch_no: r.vch_no, party: r.party || '', amount: money(r.amount) }))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));

        return R.successResponse(res, {
            summary: {
                count: rows.length,
                sales: sumBy(invoices, 'Sales'), purchase: sumBy(invoices, 'Purchase'),
                receipts: sumBy(pays, 'Receipt'), payments: sumBy(pays, 'Payment'),
            },
            data: rows, meta: { total: rows.length, page: 1, per_page: rows.length },
        });
    } catch (err) {
        console.error('reports.dayBook error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /reports/outstanding?type=receivable|payable
 * Receivable: per customer  opening + Σ sales − Σ receipts.
 * Payable:    per supplier  opening + Σ purchases − Σ payments.
 * Only parties with a non-zero balance are returned.
 */
async function outstanding(req, res) {
    try {
        const cid = req.companyId;
        const payable = req.query.type === 'payable';
        const partyTable = payable ? 'suppliers' : 'customers';
        const fkCol = payable ? 'supplier_id' : 'customer_id';
        const invType = payable ? 'purchase' : 'sales';
        const payType = payable ? 'payment' : 'receipt';

        const parties = await db(partyTable).where('company_id', cid).whereNull('deleted_at')
            .select('id', 'name', 'gst_number', 'opening_balance');
        const inv = await db('invoices').where({ company_id: cid, type: invType }).whereNull('deleted_at')
            .groupBy(fkCol).select(fkCol).sum('total as t');
        const pay = await db('payments').where({ company_id: cid, type: payType }).whereNull('deleted_at')
            .groupBy(fkCol).select(fkCol).sum('amount as t');

        const invMap = {}, payMap = {};
        inv.forEach((r) => { invMap[r[fkCol]] = Number(r.t || 0); });
        pay.forEach((r) => { payMap[r[fkCol]] = Number(r.t || 0); });

        const rows = parties.map((p) => {
            const opening = Number(p.opening_balance || 0);
            const invoiced = invMap[p.id] || 0;
            const settled = payMap[p.id] || 0;
            return {
                party_id: p.id, party: p.name, gstin: p.gst_number || '',
                opening: money(opening), invoiced: money(invoiced), settled: money(settled),
                balance: money(opening + invoiced - settled),
            };
        }).filter((r) => Math.abs(r.balance) > 0.001)
          .sort((a, b) => b.balance - a.balance);

        return R.successResponse(res, {
            type: payable ? 'payable' : 'receivable',
            summary: { count: rows.length, total_outstanding: money(rows.reduce((s, r) => s + r.balance, 0)) },
            data: rows, meta: { total: rows.length, page: 1, per_page: rows.length },
        });
    } catch (err) {
        console.error('reports.outstanding error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /reports/gst-summary — output GST (on sales) vs input GST (on purchases)
 * + net payable. Optional ?date_from ?date_to.
 */
async function gstSummary(req, res) {
    try {
        const cid = req.companyId;
        const df = req.query.date_from, dt = req.query.date_to;
        async function agg(type) {
            let q = db('invoices').where({ company_id: cid, type }).whereNull('deleted_at');
            if (df) q = q.where('invoice_date', '>=', df);
            if (dt) q = q.where('invoice_date', '<=', dt);
            const r = await q.count('id as count').sum('taxable as taxable')
                .sum('cgst as cgst').sum('sgst as sgst').sum('igst as igst').sum('tax_amount as tax').first();
            return {
                count: Number(r.count || 0), taxable: money(r.taxable),
                cgst: money(r.cgst), sgst: money(r.sgst), igst: money(r.igst), tax: money(r.tax),
            };
        }
        const outward = await agg('sales');
        const inward = await agg('purchase');
        return R.successResponse(res, {
            outward, inward, net_payable: money(outward.tax - inward.tax),
        });
    } catch (err) {
        console.error('reports.gstSummary error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /reports/stock-summary — products with current stock + value.
 * (current == opening_stock until a movement ledger exists, mirroring the
 * Inventory page.)
 */
async function stockSummary(req, res) {
    try {
        const cid = req.companyId;
        const rows = await db('products')
            .leftJoin('categories', 'categories.id', 'products.category_id')
            .where('products.company_id', cid).whereNull('products.deleted_at')
            .orderBy('products.name', 'asc')
            .select('products.name', 'products.unit', 'products.opening_stock',
                    'products.sales_price', 'categories.name as category');
        const data = rows.map((r) => {
            const qty = Number(r.opening_stock || 0);
            const rate = Number(r.sales_price || 0);
            return {
                name: r.name, category: r.category || '', unit: r.unit || '',
                qty, rate: money(rate), value: money(qty * rate),
                status: qty <= 0 ? 'Out of Stock' : (qty < 50 ? 'Low Stock' : 'In Stock'),
            };
        });
        const summary = {
            skus: data.length,
            total_qty: money(data.reduce((s, r) => s + r.qty, 0)),
            total_value: money(data.reduce((s, r) => s + r.value, 0)),
            low: data.filter((r) => r.status === 'Low Stock').length,
            out: data.filter((r) => r.status === 'Out of Stock').length,
        };
        return R.successResponse(res, { summary, data, meta: { total: data.length, page: 1, per_page: data.length } });
    } catch (err) {
        console.error('reports.stockSummary error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /reports/ledger?party_type=customer|supplier&party_id=N
 * A party's account statement: opening balance + every voucher (invoice +
 * receipt/payment) in date order with a running balance (Tally ledger style).
 */
async function partyLedger(req, res) {
    try {
        const cid = req.companyId;
        const isCustomer = req.query.party_type !== 'supplier';
        const partyId = Number(req.query.party_id);
        const table = isCustomer ? 'customers' : 'suppliers';
        const fkCol = isCustomer ? 'customer_id' : 'supplier_id';

        const party = await db(table).where({ id: partyId, company_id: cid }).whereNull('deleted_at')
            .first('name', 'gst_number', 'opening_balance');
        if (!party) return R.errorResponse(res, 'Party not found.', 404);

        const invoices = await db('invoices')
            .where({ company_id: cid, type: isCustomer ? 'sales' : 'purchase', [fkCol]: partyId })
            .whereNull('deleted_at').select('invoice_date as date', 'invoice_no as ref', 'total');
        const pays = await db('payments')
            .where({ company_id: cid, type: isCustomer ? 'receipt' : 'payment', [fkCol]: partyId })
            .whereNull('deleted_at').select('payment_date as date', 'voucher_no as ref', 'amount');

        // Customer: invoice = Debit (owes more), receipt = Credit. Supplier:
        // bill = Credit (we owe more), payment = Debit. Running balance is the
        // party's outstanding (receivable for a customer, payable for a supplier).
        const entries = [];
        invoices.forEach((i) => entries.push({
            date: i.date, vtype: isCustomer ? 'Sales Invoice' : 'Purchase Bill', ref: i.ref,
            debit: isCustomer ? Number(i.total) : 0, credit: isCustomer ? 0 : Number(i.total),
        }));
        pays.forEach((p) => entries.push({
            date: p.date, vtype: isCustomer ? 'Receipt' : 'Payment', ref: p.ref,
            debit: isCustomer ? 0 : Number(p.amount), credit: isCustomer ? Number(p.amount) : 0,
        }));
        entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));

        const opening = Number(party.opening_balance || 0);
        let bal = opening;
        const rows = entries.map((e) => {
            bal += (e.debit - e.credit);
            return { date: e.date, vtype: e.vtype, ref: e.ref, debit: money(e.debit), credit: money(e.credit), balance: money(bal) };
        });

        return R.successResponse(res, {
            party: { name: party.name, gstin: party.gst_number || '', type: isCustomer ? 'customer' : 'supplier' },
            opening: money(opening), closing: money(bal),
            totals: { debit: money(entries.reduce((s, e) => s + e.debit, 0)), credit: money(entries.reduce((s, e) => s + e.credit, 0)) },
            data: rows,
        });
    } catch (err) {
        console.error('reports.partyLedger error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* Shared financial aggregates (derived from cloud transactions). These are an
 * approximation of a full ledger — Tally keeps the authoritative double entry;
 * the cloud derives the headline figures from its invoices/payments/masters. */
async function financialBase(cid) {
    const invSum = async (type, col) => {
        const r = await db('invoices').where({ company_id: cid, type }).whereNull('deleted_at').sum(`${col} as t`).first();
        return money(r && r.t);
    };
    const paySum = async (type) => {
        const r = await db('payments').where({ company_id: cid, type }).whereNull('deleted_at').sum('amount as t').first();
        return money(r && r.t);
    };
    const sumExpr = async (table, expr) => {
        const r = await db(table).where({ company_id: cid }).whereNull('deleted_at')
            .select(db.raw(`COALESCE(SUM(${expr}),0) as t`)).first();
        return money(r && r.t);
    };

    const salesTaxable  = await invSum('sales', 'taxable');
    const salesTax      = await invSum('sales', 'tax_amount');
    const salesTotal    = await invSum('sales', 'total');
    const purchTaxable  = await invSum('purchase', 'taxable');
    const purchTax      = await invSum('purchase', 'tax_amount');
    const purchTotal    = await invSum('purchase', 'total');
    const receipts      = await paySum('receipt');
    const payments      = await paySum('payment');
    const custOpen      = await sumExpr('customers', 'opening_balance');
    const supOpen       = await sumExpr('suppliers', 'opening_balance');
    const stockValue    = await sumExpr('products', 'sales_price * opening_stock');

    return {
        salesTaxable, salesTax, salesTotal, purchTaxable, purchTax, purchTotal,
        receipts, payments, stockValue,
        receivables: money(custOpen + salesTotal - receipts),
        payables:    money(supOpen + purchTotal - payments),
        cash:        money(receipts - payments),
        grossProfit: money(salesTaxable - purchTaxable),
    };
}

/** GET /reports/trial-balance — derived ledger-group Dr/Cr balances. */
async function trialBalance(req, res) {
    try {
        const f = await financialBase(req.companyId);
        const rows = [
            { ledger: 'Sundry Debtors',     debit: Math.max(0, f.receivables), credit: Math.max(0, -f.receivables) },
            { ledger: 'Sundry Creditors',   debit: 0, credit: f.payables },
            { ledger: 'Cash / Bank',        debit: Math.max(0, f.cash), credit: Math.max(0, -f.cash) },
            { ledger: 'Closing Stock',      debit: f.stockValue, credit: 0 },
            { ledger: 'Purchase A/c',       debit: f.purchTaxable, credit: 0 },
            { ledger: 'Input GST',          debit: f.purchTax, credit: 0 },
            { ledger: 'Sales A/c',          debit: 0, credit: f.salesTaxable },
            { ledger: 'Output GST',         debit: 0, credit: f.salesTax },
        ];
        let totalDr = money(rows.reduce((s, r) => s + r.debit, 0));
        let totalCr = money(rows.reduce((s, r) => s + r.credit, 0));
        // Balancing figure (capital / profit / opening difference).
        const diff = money(totalDr - totalCr);
        if (Math.abs(diff) > 0.001) {
            rows.push({ ledger: 'Capital / Difference', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0 });
            totalDr = money(totalDr + (diff < 0 ? -diff : 0));
            totalCr = money(totalCr + (diff > 0 ? diff : 0));
        }
        return R.successResponse(res, {
            data: rows.map((r) => ({ ledger: r.ledger, debit: money(r.debit), credit: money(r.credit) })),
            totals: { debit: totalDr, credit: totalCr },
        });
    } catch (err) {
        console.error('reports.trialBalance error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /reports/profit-loss — derived trading + P&L (Expenses | Income). */
async function profitLoss(req, res) {
    try {
        const f = await financialBase(req.companyId);
        const left = [{ label: 'Purchases', amount: f.purchTaxable }];   // Dr side
        const right = [{ label: 'Sales', amount: f.salesTaxable }];      // Cr side
        const profit = f.grossProfit;
        if (profit >= 0) left.push({ label: 'Gross Profit c/f', amount: profit });
        else right.push({ label: 'Gross Loss c/f', amount: -profit });
        const leftTotal = money(left.reduce((s, r) => s + r.amount, 0));
        const rightTotal = money(right.reduce((s, r) => s + r.amount, 0));
        return R.successResponse(res, {
            left, right, left_total: leftTotal, right_total: rightTotal,
            gross_profit: profit, sales: f.salesTaxable, purchases: f.purchTaxable,
        });
    } catch (err) {
        console.error('reports.profitLoss error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /reports/balance-sheet — derived Balance Sheet (Liabilities | Assets). */
async function balanceSheet(req, res) {
    try {
        const f = await financialBase(req.companyId);
        const liabilities = [
            { label: 'Sundry Creditors', amount: f.payables },
            { label: 'Profit & Loss A/c', amount: f.grossProfit },
        ];
        const assets = [
            { label: 'Sundry Debtors', amount: f.receivables },
            { label: 'Closing Stock', amount: f.stockValue },
            { label: 'Cash / Bank', amount: f.cash },
        ];
        let liabTotal = money(liabilities.reduce((s, r) => s + r.amount, 0));
        let assetTotal = money(assets.reduce((s, r) => s + r.amount, 0));
        // Balancing capital figure so both sides agree (derived).
        const diff = money(assetTotal - liabTotal);
        if (Math.abs(diff) > 0.001) {
            liabilities.unshift({ label: 'Capital A/c (balancing)', amount: diff });
            liabTotal = money(liabTotal + diff);
        }
        return R.successResponse(res, { liabilities, assets, liab_total: liabTotal, asset_total: assetTotal });
    } catch (err) {
        console.error('reports.balanceSheet error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    salesRegister,
    dayBook,
    outstanding,
    gstSummary,
    stockSummary,
    partyLedger,
    trialBalance,
    profitLoss,
    balanceSheet,
};
