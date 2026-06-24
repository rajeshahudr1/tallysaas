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

    // Per-user location scoping: restrict to the user's location when set.
    if (req.locationId != null) qb = qb.where('invoices.location_id', req.locationId);

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
        // Location scoping: invoices carry location_id (payments do not, so the
        // receipt/payment side of the day book stays company-wide).
        if (req.locationId != null) invQ = invQ.where('invoices.location_id', req.locationId);
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

        // Location scoping: customers/suppliers and invoices carry location_id;
        // payments do not (kept company-wide).
        const partiesQ = db(partyTable).where('company_id', cid).whereNull('deleted_at');
        if (req.locationId != null) partiesQ.where('location_id', req.locationId);
        const parties = await partiesQ.select('id', 'name', 'gst_number', 'opening_balance');

        const invQ = db('invoices').where({ company_id: cid, type: invType }).whereNull('deleted_at');
        if (req.locationId != null) invQ.where('location_id', req.locationId);
        const inv = await invQ.groupBy(fkCol).select(fkCol).sum('total as t');

        const pay = await db('payments').where({ company_id: cid, type: payType }).whereNull('deleted_at')
            .groupBy(fkCol).select(fkCol).sum('amount as t');

        const invMap = {}, payMap = {};
        inv.forEach((r) => { invMap[r[fkCol]] = Number(r.t || 0); });
        pay.forEach((r) => { payMap[r[fkCol]] = Number(r.t || 0); });

        // When Tally closing balances are synced, use each party's LEDGER closing
        // balance as the AUTHORITATIVE outstanding (matches Tally exactly). The
        // opening/invoiced/settled columns still show the reconstruction breakup.
        // Tally sign: a customer (receivable) closes Dr (-ve); a supplier (payable)
        // closes Cr (+ve) — surface both as a positive "amount owed".
        const useClosing = await hasClosingBalances(cid);
        const closingByName = {};
        if (useClosing) {
            const lrows = await db('tally_ledgers').where('company_id', cid)
                .select('name', 'closing_balance');
            lrows.forEach((l) => {
                closingByName[String(l.name || '').trim().toLowerCase()] = Number(l.closing_balance) || 0;
            });
        }

        const rows = parties.map((p) => {
            const opening = Number(p.opening_balance || 0);
            const invoiced = invMap[p.id] || 0;
            const settled = payMap[p.id] || 0;
            const cb = closingByName[String(p.name || '').trim().toLowerCase()];
            const balance = (useClosing && cb !== undefined)
                ? (payable ? cb : -cb)               // ledger closing → owed amount
                : (opening + invoiced - settled);    // fallback reconstruction
            return {
                party_id: p.id, party: p.name, gstin: p.gst_number || '',
                opening: money(opening), invoiced: money(invoiced), settled: money(settled),
                balance: money(balance),
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
        // GST from the DOUBLE-ENTRY: the reconstructed invoices don't carry the
        // CGST/SGST/IGST split, but tally_voucher_entries does (the C/S/I GST
        // ledger postings). Output = on sales vouchers, input = on purchases.
        async function sumPat(vmatch, pat, excl) {
            let q = db('tally_voucher_entries').where('company_id', cid)
                .whereRaw('voucher_type ilike ?', [vmatch])
                .whereRaw('ledger_name ~* ?', [pat]);
            if (excl) q = q.whereRaw('ledger_name !~* ?', [excl]);
            const r = await q.sum('amount as s').first();
            return Math.abs(Number(r && r.s) || 0);
        }
        async function agg(vmatch) {
            const cgst = await sumPat(vmatch, 'c ?gst');
            const sgst = await sumPat(vmatch, 's ?gst');
            const igst = await sumPat(vmatch, 'i ?gst');
            // Taxable = value of the sales/purchase ledgers, EXCLUDING any GST/round-off.
            const base = vmatch.indexOf('sales') > -1 ? 'sales' : 'purchase';
            const taxable = await sumPat(vmatch, base, 'gst|round');
            return {
                count: 0, taxable: money(taxable),
                cgst: money(cgst), sgst: money(sgst), igst: money(igst), tax: money(cgst + sgst + igst),
            };
        }
        const outward = await agg('%sales%');
        const inward = await agg('%purchase%');
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
        // EXACT mirror: serve Tally's own Stock Summary snapshot when synced
        // (item-wise closing qty / rate / value verbatim).
        const snap = await tallySnapshot(cid, 'stock_summary');
        if (snap && Array.isArray(snap.rows)) {
            const data = snap.rows.map((r) => {
                const qm = String(r.qty || '').match(/^\s*([\-\d.,]+)\s*(.*)$/);
                const qty = qm ? (Number(String(qm[1]).replace(/,/g, '')) || 0) : 0;
                const unit = qm ? qm[2].trim() : '';
                return {
                    name: r.name, category: '', unit, qty, rate: money(r.rate), value: money(r.amount),
                    status: qty <= 0 ? 'Out of Stock' : (qty < 50 ? 'Low Stock' : 'In Stock'),
                };
            });
            const summary = {
                skus: data.length,
                total_qty: money(data.reduce((s, r) => s + r.qty, 0)),
                total_value: money(snap.total != null ? snap.total : data.reduce((s, r) => s + r.value, 0)),
                low: data.filter((r) => r.status === 'Low Stock').length,
                out: data.filter((r) => r.status === 'Out of Stock').length,
            };
            return R.successResponse(res, { summary, data, meta: { total: data.length, page: 1, per_page: data.length }, source: 'tally' });
        }
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

        // FULL LEDGER statement (?ledger=<name>) — ANY of the real Tally ledgers
        // from the double-entry: opening + every posting in date order with a
        // running balance (Tally ledger style). Sign: -ve = Debit, +ve = Credit.
        const ledgerName = String(req.query.ledger || '').trim();
        if (ledgerName) {
            const led = await db('tally_ledgers').where('company_id', cid)
                .whereRaw('lower(name)=lower(?)', [ledgerName])
                .first('name', 'opening_balance', 'parent');
            if (!led) return R.errorResponse(res, 'Ledger not found.', 404);
            const posts = await db('tally_voucher_entries').where('company_id', cid)
                .whereRaw('lower(ledger_name)=lower(?)', [ledgerName])
                .orderBy('voucher_date', 'asc').orderBy('id', 'asc')
                .select('voucher_date as date', 'voucher_type as vtype', 'voucher_no as ref', 'amount');
            const opening = Number(led.opening_balance) || 0;
            let running = opening;
            const rows = posts.map((p) => {
                const amt = Number(p.amount) || 0;
                running += amt;
                return {
                    date: p.date, vtype: p.vtype, ref: p.ref,
                    debit: amt < 0 ? money(-amt) : 0, credit: amt > 0 ? money(amt) : 0,
                    balance: money(running),
                };
            });
            return R.successResponse(res, {
                party: { name: led.name, group: led.parent },
                opening: money(opening), closing: money(running), entries: rows,
                totals: {
                    debit: money(rows.reduce((s, r) => s + r.debit, 0)),
                    credit: money(rows.reduce((s, r) => s + r.credit, 0)),
                },
            });
        }

        const isCustomer = req.query.party_type !== 'supplier';
        const partyId = Number(req.query.party_id);
        const table = isCustomer ? 'customers' : 'suppliers';
        const fkCol = isCustomer ? 'customer_id' : 'supplier_id';

        // Location scoping: a restricted user may only open a party / invoices in
        // their own location (payments carry no location_id → company-wide).
        const partyQ = db(table).where({ id: partyId, company_id: cid }).whereNull('deleted_at');
        if (req.locationId != null) partyQ.where('location_id', req.locationId);
        const party = await partyQ.first('name', 'gst_number', 'opening_balance');
        if (!party) return R.errorResponse(res, 'Party not found.', 404);

        const invoicesQ = db('invoices')
            .where({ company_id: cid, type: isCustomer ? 'sales' : 'purchase', [fkCol]: partyId })
            .whereNull('deleted_at');
        if (req.locationId != null) invoicesQ.where('location_id', req.locationId);
        const invoices = await invoicesQ.select('invoice_date as date', 'invoice_no as ref', 'total');
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
async function financialBase(cid, locationId = null) {
    // Location scoping: invoices + customers/suppliers carry location_id, so they
    // are filtered for a location-restricted user; payments and products have NO
    // location_id and stay company-wide.
    const invSum = async (type, col) => {
        const q = db('invoices').where({ company_id: cid, type }).whereNull('deleted_at');
        if (locationId != null) q.where('location_id', locationId);
        const r = await q.sum(`${col} as t`).first();
        return money(r && r.t);
    };
    const paySum = async (type) => {
        const r = await db('payments').where({ company_id: cid, type }).whereNull('deleted_at').sum('amount as t').first();
        return money(r && r.t);
    };
    // `locationScoped` flags tables that carry location_id (customers/suppliers
    // do; products does not).
    const sumExpr = async (table, expr, locationScoped = false) => {
        const q = db(table).where({ company_id: cid }).whereNull('deleted_at');
        if (locationScoped && locationId != null) q.where('location_id', locationId);
        const r = await q.select(db.raw(`COALESCE(SUM(${expr}),0) as t`)).first();
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
    const custOpen      = await sumExpr('customers', 'opening_balance', true);
    const supOpen       = await sumExpr('suppliers', 'opening_balance', true);
    const stockValue    = await sumExpr('products', 'sales_price * opening_stock');   // no location_id

    return {
        salesTaxable, salesTax, salesTotal, purchTaxable, purchTax, purchTotal,
        receipts, payments, stockValue,
        receivables: money(custOpen + salesTotal - receipts),
        payables:    money(supOpen + purchTotal - payments),
        cash:        money(receipts - payments),
        grossProfit: money(salesTaxable - purchTaxable),
    };
}

/** Fetch a Tally report SNAPSHOT (pulled verbatim by the agent) for exact-match
 *  rendering. Returns the parsed payload object, or null when not yet synced. */
async function tallySnapshot(cid, reportType) {
    try {
        const row = await db('tally_reports')
            .where({ company_id: cid, report_type: reportType })
            .first('payload');
        if (!row || !row.payload) return null;
        return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch (_) { return null; }
}

/** Whether this company has Tally CLOSING balances synced (any non-zero). When
 *  yes, reports use those authoritative per-ledger balances directly (EXACT match
 *  to Tally); else they fall back to reconstructing opening + Σ(postings). */
async function hasClosingBalances(cid) {
    try {
        const [{ cc }] = await db('tally_ledgers').where('company_id', cid)
            .whereRaw('coalesce(closing_balance,0) <> 0').count({ cc: '*' });
        return Number(cc) > 0;
    } catch (_) { return false; }
}

/** GET /reports/trial-balance — REAL per-ledger Dr/Cr from Tally. Uses the synced
 *  CLOSING balance when available (exact), else opening + Σ(postings). Tally sign:
 *  +ve balance = Credit, -ve = Debit (ISDEEMEDPOSITIVE). Total Dr must = Cr. */
async function trialBalance(req, res) {
    try {
        const cid = req.companyId;
        // EXACT mirror: serve Tally's own Trial Balance snapshot when synced.
        const snap = await tallySnapshot(cid, 'trial_balance');
        if (snap && Array.isArray(snap.rows)) {
            const data = snap.rows.map((r) => ({
                ledger: r.name, group: '', debit: money(r.debit), credit: money(r.credit),
            }));
            let dt = money(snap.debit_total), ct = money(snap.credit_total);
            // Tally shows a 'Difference in opening balances' row so Dr = Cr ties.
            const diff = money(ct - dt);
            if (Math.abs(diff) > 0.01) {
                data.push({ ledger: 'Difference in opening balances', group: 'Difference',
                            debit: diff > 0 ? diff : 0, credit: diff < 0 ? money(-diff) : 0 });
                if (diff > 0) dt = money(dt + diff); else ct = money(ct - diff);
            }
            return R.successResponse(res, { data, totals: { debit: dt, credit: ct }, source: 'tally' });
        }
        const balExpr = (await hasClosingBalances(cid))
            ? 'coalesce(l.closing_balance,0)'
            : 'coalesce(l.opening_balance,0) + coalesce(p.posted,0)';
        const result = await db.raw(
            `select l.name as ledger, l.parent as grp,
                    ${balExpr} as balance
               from tally_ledgers l
               left join (
                    select lower(ledger_name) as ln, sum(amount) as posted
                      from tally_voucher_entries where company_id = ?
                     group by lower(ledger_name)
               ) p on p.ln = lower(l.name)
              where l.company_id = ?
              order by l.parent, l.name`, [cid, cid]);
        let totalDr = 0, totalCr = 0;
        const data = (result.rows || []).map((r) => {
            const bal = Number(r.balance) || 0;
            const debit = bal < 0 ? -bal : 0;     // -ve balance = Debit side
            const credit = bal > 0 ? bal : 0;     // +ve balance = Credit side
            totalDr += debit; totalCr += credit;
            return { ledger: r.ledger, group: r.grp || '', debit: money(debit), credit: money(credit) };
        }).filter((r) => r.debit || r.credit);
        // Opening-difference balancing row (some opening balances may be
        // un-captured until ledgers fully refine) so the statement still ties.
        const diff = money(totalDr - totalCr);
        if (Math.abs(diff) > 0.01) {
            data.push({ ledger: 'Difference in Opening Balances', group: 'Difference',
                        debit: diff < 0 ? money(-diff) : 0, credit: diff > 0 ? money(diff) : 0 });
            if (diff < 0) totalDr = money(totalDr - diff);
            else totalCr = money(totalCr + diff);
        }
        return R.successResponse(res, {
            data,
            totals: { debit: money(totalDr), credit: money(totalCr) },
        });
    } catch (err) {
        console.error('reports.trialBalance error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** Real per-ledger balances (opening + Σ postings) + each ledger's P&L-vs-Balance
 *  Sheet nature, resolved by walking tally_groups up to a revenue primary group. */
async function realLedgerBalances(cid) {
    const groups = await db('tally_groups').where('company_id', cid)
        .select('name', 'parent', 'is_revenue');
    const gmap = {};
    groups.forEach((g) => { gmap[String(g.name || '').toLowerCase()] = g; });
    const isRev = (gname, depth = 0) => {
        if (depth > 25) return false;
        const g = gmap[String(gname || '').toLowerCase()];
        if (!g) return false;
        if (g.is_revenue) return true;
        const p = String(g.parent || '');
        if (!p || /primary/i.test(p) || p.toLowerCase() === String(gname).toLowerCase()) return false;
        return isRev(p, depth + 1);
    };
    // Prefer Tally's AUTHORITATIVE per-ledger CLOSING balance (synced) for an
    // exact match — it already folds in opening + every posting + inventory
    // valuation. Fall back to opening + Σ(postings) only until closing balances
    // are synced (older agent / pre-sync), so there is never a regression.
    const balExpr = (await hasClosingBalances(cid))
        ? 'coalesce(l.closing_balance,0)'
        : 'coalesce(l.opening_balance,0)+coalesce(p.posted,0)';
    const result = await db.raw(
        `select l.name as ledger, l.parent as grp,
                ${balExpr} as balance
           from tally_ledgers l
           left join (select lower(ledger_name) as ln, sum(amount) as posted
                        from tally_voucher_entries where company_id=? group by lower(ledger_name)) p
             on p.ln=lower(l.name)
          where l.company_id=?`, [cid, cid]);
    return (result.rows || []).map((r) => ({
        name: r.ledger, group: r.grp || '', balance: Number(r.balance) || 0,
        isRevenue: isRev(r.grp),
    }));
}

/** Aggregate ledgers by their parent group → [{label, balance}]. */
function aggByGroup(ledgers) {
    const m = {};
    ledgers.forEach((l) => {
        const k = l.group || l.name;
        if (!m[k]) m[k] = { label: k, balance: 0 };
        m[k].balance += l.balance;
    });
    return Object.values(m).filter((g) => Math.abs(g.balance) > 0.01);
}

/** GET /reports/profit-loss — REAL P&L from revenue ledgers (Tally sign: +ve = Cr
 *  income, -ve = Dr expense). Net = income − expense. */
async function profitLoss(req, res) {
    try {
        // EXACT mirror: serve Tally's own Profit & Loss snapshot when synced
        // (income = credit side, expense = debit side — Tally's verbatim rows).
        const snap = await tallySnapshot(req.companyId, 'profit_loss');
        if (snap && (Array.isArray(snap.income) || Array.isArray(snap.expense))) {
            const right = (snap.income || []).map((r) => ({ label: r.name, amount: money(r.amount) }));
            const left  = (snap.expense || []).map((r) => ({ label: r.name, amount: money(r.amount) }));
            let lt = money(left.reduce((s, r) => s + r.amount, 0));
            let rt = money(right.reduce((s, r) => s + r.amount, 0));
            // Balance with the Net Profit / Net Loss line (Tally's bottom line).
            const net = money(rt - lt);                  // +ve = profit
            if (net >= 0) left.push({ label: 'Net Profit', amount: net });
            else          right.push({ label: 'Net Loss', amount: money(-net) });
            lt = money(left.reduce((s, r) => s + r.amount, 0));
            rt = money(right.reduce((s, r) => s + r.amount, 0));
            // Sub-rows under each main group (Opening Stock / Purchases / Closing
            // Stock / Direct Expenses under Cost of Sales) for Tally-style detail.
            const details = Array.isArray(snap.details) ? snap.details : [];
            return R.successResponse(res, {
                left, right, left_total: lt, right_total: rt,
                gross_profit: net, details, source: 'tally',
            });
        }
        const rev = (await realLedgerBalances(req.companyId)).filter((l) => l.isRevenue);
        const left = [], right = [];   // left = Dr (Expenses), right = Cr (Income)
        aggByGroup(rev).forEach((g) => {
            if (g.balance < 0) left.push({ label: g.label, amount: money(-g.balance) });
            else right.push({ label: g.label, amount: money(g.balance) });
        });
        let leftTotal = money(left.reduce((s, r) => s + r.amount, 0));
        let rightTotal = money(right.reduce((s, r) => s + r.amount, 0));
        const profit = money(rightTotal - leftTotal);
        if (profit >= 0) left.push({ label: 'Net Profit', amount: profit });
        else right.push({ label: 'Net Loss', amount: money(-profit) });
        leftTotal = money(left.reduce((s, r) => s + r.amount, 0));
        rightTotal = money(right.reduce((s, r) => s + r.amount, 0));
        return R.successResponse(res, {
            left, right, left_total: leftTotal, right_total: rightTotal,
            gross_profit: profit, sales: rightTotal, purchases: leftTotal,
        });
    } catch (err) {
        console.error('reports.profitLoss error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /reports/balance-sheet — REAL Balance Sheet from non-revenue ledgers
 *  (+ve = Cr liability, -ve = Dr asset), with the P&L result on the capital side. */
async function balanceSheet(req, res) {
    try {
        // EXACT mirror: serve Tally's own Balance Sheet snapshot when synced.
        const snap = await tallySnapshot(req.companyId, 'balance_sheet');
        if (snap && Array.isArray(snap.liabilities) && Array.isArray(snap.assets)) {
            const liabilities = snap.liabilities.map((r) => ({ label: r.name, amount: money(r.amount) }));
            const assets = snap.assets.map((r) => ({ label: r.name, amount: money(r.amount) }));
            return R.successResponse(res, {
                liabilities, assets,
                liab_total: money(liabilities.reduce((s, r) => s + r.amount, 0)),
                asset_total: money(assets.reduce((s, r) => s + r.amount, 0)),
                source: 'tally',
            });
        }
        const all = await realLedgerBalances(req.companyId);
        const liabilities = [], assets = [];
        aggByGroup(all.filter((l) => !l.isRevenue)).forEach((g) => {
            if (g.balance > 0) liabilities.push({ label: g.label, amount: money(g.balance) });
            else assets.push({ label: g.label, amount: money(-g.balance) });
        });
        // Net profit (Σ revenue ledgers; +ve = profit) carries to the capital side.
        const profit = money((all.filter((l) => l.isRevenue)).reduce((s, l) => s + l.balance, 0));
        if (Math.abs(profit) > 0.01) {
            if (profit > 0) liabilities.push({ label: 'Profit & Loss A/c', amount: profit });
            else assets.push({ label: 'Profit & Loss A/c (Loss)', amount: money(-profit) });
        }
        let liabTotal = money(liabilities.reduce((s, r) => s + r.amount, 0));
        let assetTotal = money(assets.reduce((s, r) => s + r.amount, 0));
        const diff = money(assetTotal - liabTotal);
        if (Math.abs(diff) > 0.01) {
            if (diff > 0) liabilities.unshift({ label: 'Difference / Capital', amount: diff });
            else assets.unshift({ label: 'Difference', amount: money(-diff) });
            liabTotal = money(liabilities.reduce((s, r) => s + r.amount, 0));
            assetTotal = money(assets.reduce((s, r) => s + r.amount, 0));
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
