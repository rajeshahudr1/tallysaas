'use strict';

/**
 * api/Controllers/Tenant/InvoiceController.js
 *
 * The bespoke invoices controller — unlike CustomerController this is NOT wired
 * through the crudController factory, because invoices own a nested `items`
 * collection that must be written atomically alongside the header row, and the
 * money totals must be COMPUTED server-side (never trusted from the client).
 *
 * One `invoices` table backs two voucher kinds discriminated by `type`:
 *   • 'sales'    — keyed on customer_id, may carry sales_person_id.
 *   • 'purchase' — keyed on supplier_id, may carry supplier_bill_no.
 *
 * Exports the six handlers the routes need:
 *   { listSales, listPurchase, get, createSales, createPurchase, destroy }
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; taxable = gross-discAmt ;
 *   gstAmt = taxable*gst% ; amount = taxable+gstAmt  (each rounded to 2dp).
 * Header totals sum the lines; cgst=sgst=tax/2, igst=0 (intra-state assumption);
 * total = round(taxable+tax) ; round_off = total-(taxable+tax).
 *
 * invoice_no is generated INSIDE the transaction as
 *   <INV|PUR>-<year-of-invoice_date>-<0000 padded company+type sequence>
 * counting ALL existing rows of that type for the company (soft-deleted too) so
 * numbers never collide with the `uq_invoices_company_type_no` unique index.
 *
 * Conventions: company-scoped by req.companyId (resolveCompany), whereNull
 * deleted_at, every handler async + try/catch → console.error + 500 envelope.
 */

const db = require('../../config/db').db;
const { MOVEMENT_SUBQUERY, closingStockSql } = require('../../Helpers/stockMovement');
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { invoicePdfHtml } = require('../../Helpers/transactionPdf');
const customerUsers = require('./CustomerUserController');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG    = 'Invoice not found.';
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'invoices.*',
    'customers.name as customer',
    'suppliers.name as supplier',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

/**
 * Reproduce Tally's Sales/Purchase Register membership exactly. Tally EXCLUDES:
 *   • returns — Credit Notes (sales) / Debit Notes (purchase) live in their own
 *     register; the cloud maps them onto type='sales'/'purchase' too, and
 *   • OPTIONAL / CANCELLED vouchers — unposted drafts that show only in the Day
 *     Book (flagged via invoices.tally_optional).
 * Cloud-created invoices (tally_voucher_type NULL, tally_optional false) are
 * real sales and stay in.
 */
function excludeReturns(qb, type) {
    const returnType = type === 'sales' ? 'Credit Note' : 'Debit Note';
    return qb
        .where('invoices.tally_optional', false)
        .where((b) =>
            b.whereNull('invoices.tally_voucher_type')
             .orWhere('invoices.tally_voucher_type', '!=', returnType));
}

/**
 * Base query with the party + location label joins. The list/get handlers layer
 * `where invoices.company_id = ?`, `whereNull(invoices.deleted_at)` and the
 * type filter on top, so the tenant / deleted_at / type columns stay qualified.
 */
function baseQuery() {
    return db('invoices')
        .leftJoin('customers', 'customers.id', 'invoices.customer_id')
        .leftJoin('suppliers', 'suppliers.id', 'invoices.supplier_id')
        .leftJoin('locations', 'locations.id', 'invoices.location_id');
}

/**
 * Compute every per-line and header money value from the validated items.
 * Returns { items, totals } where items carry their computed taxable/gst_amount/
 * amount, and totals hold the header columns. Nothing here trusts the client.
 */
function computeTotals(items) {
    let subtotal = 0;   // sum of gross (qty*rate)
    let discount = 0;   // sum of per-line discount amounts
    let taxable  = 0;   // sum of per-line taxable
    let taxAmt   = 0;   // sum of per-line gst amounts

    const computed = items.map((it) => {
        const qty     = Number(it.quantity);
        const rate    = Number(it.rate);
        const discPct = Number(it.discount_pct || 0);
        const gstRate = Number(it.gst_rate || 0);

        const gross       = money(qty * rate);
        const discAmt     = money(gross * (discPct / 100));
        const lineTaxable = money(gross - discAmt);
        const gstAmt      = money(lineTaxable * (gstRate / 100));
        const amount      = money(lineTaxable + gstAmt);

        subtotal += gross;
        discount += discAmt;
        taxable  += lineTaxable;
        taxAmt   += gstAmt;

        return {
            product_id:   it.product_id || null,
            description:  it.description || null,
            hsn:          it.hsn || null,
            quantity:     qty,
            unit:         it.unit || null,
            rate,
            discount_pct: discPct,
            taxable:      lineTaxable,
            gst_rate:     gstRate,
            gst_amount:   gstAmt,
            amount,
        };
    });

    subtotal = money(subtotal);
    discount = money(discount);
    taxable  = money(taxable);
    taxAmt   = money(taxAmt);

    // Intra-state assumption: split the tax evenly across CGST/SGST, no IGST.
    const cgst = money(taxAmt / 2);
    const sgst = money(taxAmt / 2);
    const igst = 0;

    const grand    = taxable + taxAmt;
    const total    = Math.round(grand);
    const roundOff = money(total - grand);

    return {
        items: computed,
        totals: {
            subtotal,
            discount,
            taxable,
            cgst,
            sgst,
            igst,
            tax_amount: taxAmt,
            round_off:  roundOff,
            total,
        },
    };
}

// Clamp/normalise pagination from the (Joi-validated) query.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

/**
 * Shared list implementation for both voucher kinds. `type` is 'sales' or
 * 'purchase'; `partyCol` / `partyNameCol` pick which join the search + party
 * filter target.
 */
async function listByType(req, res, type) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search    = (req.query.search || '').trim();
        const status    = (req.query.status || '').trim();
        const dateFrom  = req.query.date_from;
        const dateTo    = req.query.date_to;
        const isSales   = type === 'sales';
        const partyId   = isSales ? req.query.customer_id : req.query.supplier_id;
        const partyName = isSales ? 'customers.name' : 'suppliers.name';
        const partyCol  = isSales ? 'invoices.customer_id' : 'invoices.supplier_id';

        let qb = baseQuery()
            .where('invoices.company_id', req.companyId)
            .where('invoices.type', type)
            .whereNull('invoices.deleted_at');
        qb = excludeReturns(qb, type);

        // Per-user location scoping (Requirement C): a location-restricted user
        // sees ONLY their location's invoices. Unrestricted (req.locationId null)
        // → all locations. Company scope stays the primary guard.
        if (req.locationId != null) qb = qb.where('invoices.location_id', req.locationId);
        // Field-sales scoping: a salesman sees ONLY the invoices THEY created
        // (not the whole company's / their location's). Admins are unrestricted.
        if (req.isSalesman) qb = qb.where('invoices.created_by', req.user.sub);
        // A customer-portal login sees EVERY invoice cut for THEIR customer —
        // their own portal orders AND the ones the office raised for them.
        if (req.isCustomerUser) qb = qb.where('invoices.customer_id', req.customerId);
        // "मेरे बनाए" — वैकल्पिक। न भेजा जाए तो list का पुराना व्यवहार अछूता।
        if (req.query.mine === '1' && req.user) qb = qb.where('invoices.created_by', req.user.sub);

        if (status)   qb = qb.where('invoices.status', status);

        // ?overdue=1 — invoices whose due date has passed. Backs the dashboard's
        // "Overdue Invoices" tile. NOTE: payments are recorded against a PARTY,
        // not an invoice, so this cannot net off partial receipts — it is a
        // due-date filter, not a settlement filter.
        const overdue = (req.query.overdue || '').toString().trim();
        if (overdue === '1' || overdue === 'true') {
            qb = qb.whereNotNull('invoices.due_date')
                .whereRaw('invoices.due_date < current_date')
                .whereNot('invoices.status', 'failed');
        }

        // Approval-status filter (SFA). The Sales list + register show REAL sales
        // only — an un-approved invoice (pending/draft/rejected) must NOT appear
        // here nor count in the totals until a company-admin approves it. So:
        //   • no param      → hide pending/draft/rejected (approved + legacy/Tally
        //                      rows, whose status is 'approved'/null, still show)
        //   • approval=pending|draft|rejected|approved → exactly that state
        //   • approval=all  → every state (used by an "All" tab)
        const approval = (req.query.approval || '').trim();
        if (approval === 'all') {
            /* no approval filter */
        } else if (approval) {
            qb = qb.where('invoices.approval_status', approval);
        } else {
            qb = qb.where(function () {
                this.whereNotIn('invoices.approval_status', ['pending', 'draft', 'rejected'])
                    .orWhereNull('invoices.approval_status');
            });
        }
        if (partyId)  qb = qb.where(partyCol, partyId);
        if (dateFrom) qb = qb.where('invoices.invoice_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('invoices.invoice_date', '<=', dateTo);

        // Incremental-sync filter (?last_update=...) — third-party pollers
        // (WooCommerce etc.) fetch only rows CHANGED since a point in time.
        //   • last_update=1          → updated TODAY (since local midnight)
        //   • last_update=YYYY-MM-DD → updated on/after that date/datetime
        const lastUpdate = (req.query.last_update || '').toString().trim();
        let since = null;
        if (lastUpdate) {
            since = lastUpdate;
            if (lastUpdate === '1') {
                since = new Date();
                since.setHours(0, 0, 0, 0);
            }
            qb = qb.where('invoices.updated_at', '>=', since);
        }

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('invoices.invoice_no', 'ilike', like)
                 .orWhere(partyName, 'ilike', like);
            });
        }

        // Count BEFORE pagination — clone so offset/limit/order don't leak in.
        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('invoices.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);
        // Grand total of ALL matching vouchers (for the register summary).
        const sumRow = await qb.clone().clearSelect().clearOrder()
            .sum('invoices.total as t').first();
        const grandTotal = Number(sumRow ? sumRow.t : 0) || 0;

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('invoices.id', 'desc')
            .select(...LIST_COLUMNS);

        // Tally-synced invoices are summary-only (no party FK / taxable / tax) —
        // reconstruct party + taxable + GST for THIS PAGE from the voucher
        // postings (one batched query) so the register list shows real data.
        const guids = rows.map((r) => r.tally_guid).filter(Boolean);
        if (guids.length) {
            const entries = await db('tally_voucher_entries')
                .where('company_id', req.companyId).whereIn('voucher_guid', guids)
                .select('voucher_guid', 'ledger_name', 'amount');
            const agg = {};
            entries.forEach((e) => {
                const a = agg[e.voucher_guid]
                    || (agg[e.voucher_guid] = { party: '', pAbs: -1, taxable: 0, cgst: 0, sgst: 0, igst: 0 });
                const low = String(e.ledger_name || '').toLowerCase();
                const abs = Math.abs(Number(e.amount) || 0);
                if (/c\s*gst|cgst|central/.test(low)) a.cgst += abs;
                else if (/s\s*gst|sgst|state/.test(low)) a.sgst += abs;
                else if (/i\s*gst|igst|integrated/.test(low)) a.igst += abs;
                else if (/round/.test(low)) { /* round-off: ignore for taxable */ }
                else if (/sales|purchase/.test(low)) a.taxable += abs;
                else if (abs > a.pAbs) { a.party = e.ledger_name; a.pAbs = abs; }
            });
            rows.forEach((r) => {
                const a = agg[r.tally_guid]; if (!a) return;
                const partyKey = isSales ? 'customer' : 'supplier';
                if (!r[partyKey]) r[partyKey] = a.party;
                if (!Number(r.taxable))   r.taxable = money(a.taxable);
                if (!Number(r.cgst))      r.cgst = money(a.cgst);
                if (!Number(r.sgst))      r.sgst = money(a.sgst);
                if (!Number(r.igst))      r.igst = money(a.igst);
                if (!Number(r.tax_amount)) r.tax_amount = money(a.cgst + a.sgst + a.igst);
            });
        }

        const payload = {
            data: rows,
            meta: { total, page, per_page: perPage, grand_total: grandTotal },
        };

        // Same incremental-sync contract as the generic crud list: soft-deleted
        // invoices never appear in `data`, so a third-party poller would never
        // learn a voucher was removed. With ?last_update= we also return the ids
        // deleted since the SAME cutoff, as a plain array: "deleted": [10, 1, 2].
        // Not paginated; omitted entirely when ?last_update= is absent.
        if (since) {
            let delQb = (req.db || db)('invoices')
                .where('invoices.company_id', req.companyId)
                .where('invoices.type', type)
                .whereNotNull('invoices.deleted_at')
                .where('invoices.deleted_at', '>=', since);
            // Same universe as `data`: credit/debit notes are excluded there too.
            delQb = excludeReturns(delQb, type);
            if (req.locationId != null)  delQb.where('invoices.location_id', req.locationId);
            if (req.isSalesman)          delQb.where('invoices.created_by', req.user.sub);
            if (req.isCustomerUser)      delQb.where('invoices.customer_id', req.customerId);
            const delRows = await delQb.orderBy('invoices.deleted_at', 'desc')
                .select('invoices.id as id');
            payload.deleted = delRows.map((r) => Number(r.id));
        }

        return R.successResponse(res, payload);
    } catch (err) {
        console.error(`invoices.list(${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function listSales(req, res) {
    return listByType(req, res, 'sales');
}

async function listPurchase(req, res) {
    return listByType(req, res, 'purchase');
}

/**
 * Month-wise summary for the Tally Sales/Purchase-Register view: one row per
 * calendar month with the month's voucher total + count and a running closing
 * balance, plus the grand total. invoice_date is a plain DATE so to_char gives
 * the real month (no timezone shift). Honours the FY date_from/date_to filters.
 */
/**
 * Tally report SNAPSHOT (pulled verbatim by the agent) for exact-match figures.
 *
 * The agent appends a new row on every pull, so `tally_reports` holds many
 * rows per report_type. Take the LATEST — a bare .first() returns whatever
 * order the heap happens to give, which meant a months-old (or empty) pull
 * could silently override the current register.
 */
async function tallyReportSnapshot(cid, rtype) {
    try {
        const row = await db('tally_reports')
            .where({ company_id: cid, report_type: rtype })
            .orderBy('synced_at', 'desc').orderBy('id', 'desc')
            .first('payload');
        if (!row || !row.payload) return null;
        return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch (_) { return null; }
}

// Calendar month number → Tally's month NAME (used to match the synced register).
const TALLY_MONTH_NAME = {
    '01': 'january', '02': 'february', '03': 'march', '04': 'april',
    '05': 'may', '06': 'june', '07': 'july', '08': 'august',
    '09': 'september', '10': 'october', '11': 'november', '12': 'december',
};

async function monthlyByType(req, res, type) {
    try {
        let qb = db('invoices')
            .where('invoices.company_id', req.companyId)
            .where('invoices.type', type)
            .whereNull('invoices.deleted_at');
        if (req.locationId != null) qb = qb.where('invoices.location_id', req.locationId);
        if (req.isSalesman) qb = qb.where('invoices.created_by', req.user.sub);
        // A customer-portal login sees EVERY invoice cut for THEIR customer —
        // their own portal orders AND the ones the office raised for them.
        if (req.isCustomerUser) qb = qb.where('invoices.customer_id', req.customerId);
        if (req.query.date_from) qb = qb.where('invoices.invoice_date', '>=', req.query.date_from);
        if (req.query.date_to)   qb = qb.where('invoices.invoice_date', '<=', req.query.date_to);
        // Same approval gate as the list — the register's month totals + counts
        // must exclude un-approved (pending/draft/rejected) invoices by default.
        const approval = (req.query.approval || '').trim();
        if (approval === 'all') {
            /* no approval filter */
        } else if (approval) {
            qb = qb.where('invoices.approval_status', approval);
        } else {
            qb = qb.where(function () {
                this.whereNotIn('invoices.approval_status', ['pending', 'draft', 'rejected'])
                    .orWhereNull('invoices.approval_status');
            });
        }
        qb = excludeReturns(qb, type);

        const rows = await qb
            .select(db.raw("to_char(invoices.invoice_date, 'YYYY-MM') as month"))
            .sum('invoices.total as total')
            .count('invoices.id as count')
            // App-CREATED invoices in the month (created_by set). A month with
            // any of these is a live cloud month (e.g. 2026-07) — NOT part of the
            // historical Tally register, so it must NOT inherit a same-named FY
            // month's Tally figure (2022-07). See the snapshot gate below.
            .select(db.raw('count(invoices.id) filter (where invoices.created_by is not null) as cloud_count'))
            .groupByRaw("to_char(invoices.invoice_date, 'YYYY-MM')")
            .orderByRaw("to_char(invoices.invoice_date, 'YYYY-MM')");

        // Override each month's TOTAL with Tally's EXACT register figure (synced
        // snapshot) so the register ties to Tally to the paisa — keeping the
        // cloud's voucher counts + month drill-down. Falls back to the
        // reconstruction when the register has not been synced yet.
        //
        // BUT the Tally snapshot is the WHOLE COMPANY's register, so it must NOT
        // be applied to a SCOPED view — a salesman (own invoices) or a
        // location-restricted user must see the sum of THEIR OWN invoices, not
        // the company total. For those, keep the reconstructed per-row total.
        const scoped = req.isSalesman || req.isCustomerUser || req.locationId != null;
        const snapType = type === 'purchase' ? 'purchase_register' : 'sales_register';
        const snap = scoped ? null : await tallyReportSnapshot(req.companyId, snapType);
        // A snapshot month with NO figure is not an authoritative zero — an
        // all-zero register is what a failed/partial pull looks like, and
        // trusting it blanked the whole Sales Register even though the
        // vouchers were sitting right there. Only non-zero months override.
        const byName = {};
        if (snap && Array.isArray(snap.rows)) {
            for (const r of snap.rows) {
                const amt = Number(r.amount) || 0;
                if (!amt) continue;
                byName[String(r.month || '').trim().toLowerCase()] = amt;
            }
        }
        let running = 0;
        const months = rows.map((r) => {
            const nm = TALLY_MONTH_NAME[String(r.month).slice(5)];
            // Use the Tally snapshot ONLY for a purely-historical Tally month (no
            // app-created invoices). A live cloud month (cloud_count > 0, e.g.
            // 2026-07) uses its REAL invoice sum instead of the same-named FY
            // month's Tally figure — fixes "July 2026 shows July 2022's amount".
            const isCloudMonth = (Number(r.cloud_count) || 0) > 0;
            const useTally = nm && byName[nm] !== undefined && !isCloudMonth;
            const total = useTally ? money(byName[nm]) : money(r.total);
            running = money(running + total);
            return { month: r.month, total, count: Number(r.count) || 0, closing: running };
        });
        return R.successResponse(res, {
            data: months,
            meta: { grand_total: money(running), months: months.length, source: snap ? 'tally' : 'cloud' },
        });
    } catch (err) {
        console.error(`invoices.monthly(${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function monthlySales(req, res)    { return monthlyByType(req, res, 'sales'); }
async function monthlyPurchase(req, res) { return monthlyByType(req, res, 'purchase'); }

/* ─────────────────────────────────────────────────────────────────
 * Grouped register (LiveKeeping parity).
 *
 * The web register shows the same period's vouchers regrouped six ways —
 * by Ledger (the party), Ledger Group, Voucher Type, Stock Item, Stock
 * Group or Stock Category. Three of those are HEADER groupings (one row
 * per voucher, so `total` sums cleanly) and three are LINE groupings
 * (invoice_items, which also carry a quantity).
 *
 * `mode` mirrors LiveKeeping's Gross/Net toggle:
 *   gross — returns (Credit/Debit Note voucher types) excluded, the same
 *           basis the month register and every dashboard figure use.
 *   net   — returns INCLUDED and subtracted, so the group totals net off
 *           the sales/purchase returns booked against them.
 * ───────────────────────────────────────────────────────────────── */

// group key → { level, label, expr, join } — `level` decides which table the
// SUM runs over, so a Stock Item row can never double-count a voucher header.
const GROUP_SPECS = {
    ledger:         { level: 'header', label: 'Ledger' },
    ledger_group:   { level: 'header', label: 'Ledger Group' },
    voucher_type:   { level: 'header', label: 'Voucher Type' },
    stock_item:     { level: 'line',   label: 'Stock Item' },
    stock_group:    { level: 'line',   label: 'Stock Group' },
    stock_category: { level: 'line',   label: 'Stock Category' },
};

/**
 * The scope CTE every grouping starts from: one row per voucher, already
 * carrying its party name and its Gross/Net sign. Returns { sql, binds }.
 *
 * Party name resolution, in order:
 *   1. the linked customer / supplier master (cloud-created vouchers), then
 *   2. the SYNCED voucher's counter-party ledger. A Tally sales voucher's
 *      entries are the party, the revenue ledger, the taxes and round-off;
 *      the party is reliably the largest line by magnitude, and `is_debit`
 *      is not — Tally flips its sign per voucher class, so trusting it
 *      mislabels roughly half the register.
 *
 * Every filter here mirrors monthlyByType(), so a grouped view and the Month
 * view of the same period always add up to the same grand total.
 */
function registerScopeSql(req, type, mode) {
    const binds = [];
    const w = [];
    w.push('i.company_id = ?');       binds.push(req.companyId);
    w.push('i.type = ?');             binds.push(type);
    w.push('i.deleted_at is null');
    w.push('i.tally_optional = false');
    if (req.locationId != null) { w.push('i.location_id = ?'); binds.push(req.locationId); }
    if (req.isSalesman)     { w.push('i.created_by = ?');  binds.push(req.user.sub); }
    if (req.isCustomerUser) { w.push('i.customer_id = ?'); binds.push(req.customerId); }
    if (req.query.date_from) { w.push('i.invoice_date >= ?'); binds.push(req.query.date_from); }
    if (req.query.date_to)   { w.push('i.invoice_date <= ?'); binds.push(req.query.date_to); }

    const approval = String(req.query.approval || '').trim();
    if (approval === 'all') {
        /* no approval filter */
    } else if (approval) {
        w.push('i.approval_status = ?'); binds.push(approval);
    } else {
        w.push("(i.approval_status not in ('pending','draft','rejected') or i.approval_status is null)");
    }

    // Gross drops the return vouchers entirely; net keeps them so `sgn` can
    // subtract them from whatever group they belong to.
    const returnType = type === 'sales' ? 'Credit Note' : 'Debit Note';
    let sgn = '1';
    if (mode === 'net') {
        sgn = 'case when i.tally_voucher_type = ? then -1 else 1 end';
        binds.push(returnType);
    } else {
        w.push('(i.tally_voucher_type is null or i.tally_voucher_type <> ?)');
        binds.push(returnType);
    }

    // NOTE: the `sgn` binding is emitted in the SELECT list, which precedes
    // the WHERE clause in the final SQL — so push the party subquery's bind
    // and sgn's bind in the same order the text uses them.
    const partyBinds = [req.companyId];

    const sql = `
        select
            i.id, i.total, i.tally_guid,
            coalesce(i.tally_voucher_type, ?) as vch_type,
            coalesce(
                c.name, s.name,
                (select e.ledger_name from tally_voucher_entries e
                  where e.company_id = ? and e.voucher_guid = i.tally_guid
                  order by abs(e.amount) desc limit 1),
                '(No Ledger)'
            ) as party,
            (${sgn}) as sgn
        from invoices i
        left join customers c on c.id = i.customer_id
        left join suppliers s on s.id = i.supplier_id
        where ${w.join(' and ')}
    `;
    // Bind order across the whole statement: vch_type default, party subquery
    // company id, then sgn's return type (net only), then every WHERE bind.
    const defaultVchType = type === 'sales' ? 'Sales' : 'Purchase';
    const selectBinds = mode === 'net'
        ? [defaultVchType, ...partyBinds, returnType]
        : [defaultVchType, ...partyBinds];
    // `binds` still holds the WHERE values (and, in gross mode, the trailing
    // returnType the WHERE clause uses). Drop net-mode's sgn bind — it was
    // pushed into `binds` above but belongs to the SELECT list.
    const whereBinds = mode === 'net' ? binds.slice(0, -1) : binds;
    return { sql, binds: [...selectBinds, ...whereBinds] };
}

async function groupedByType(req, res, type) {
    const by   = String(req.query.by || '').trim().toLowerCase();
    const spec = GROUP_SPECS[by];
    if (!spec) return R.errorResponse(res, 'Unknown grouping.', 422);
    const mode = String(req.query.mode || 'gross').trim().toLowerCase() === 'net' ? 'net' : 'gross';

    try {
        const scope = registerScopeSql(req, type, mode);
        let sql;
        let binds = [...scope.binds];

        if (spec.level === 'header') {
            let keyExpr;
            let extraJoin = '';
            if (by === 'ledger') {
                keyExpr = 'v.party';
            } else if (by === 'ledger_group') {
                // The Tally ledger master carries the real group ("50% SALES
                // CUSTOMER", "Sundry Debtors", …). `customer_groups` is a
                // cloud-only table the Tally sync never fills, so reading it
                // here would report every voucher as "(No Group)".
                extraJoin = 'left join tally_ledgers tl on tl.company_id = ? and lower(tl.name) = lower(v.party)';
                keyExpr = "coalesce(tl.parent, '(No Group)')";
            } else {
                keyExpr = 'v.vch_type';
            }
            sql = `
                with v as (${scope.sql})
                select ${keyExpr} as name,
                       sum(v.total * v.sgn) as amount,
                       count(v.id) as count
                from v ${extraJoin}
                group by ${keyExpr}
                order by ${keyExpr} asc
            `;
            if (by === 'ledger_group') binds = [...binds, req.companyId];
        } else {
            // Line level. A SYNCED voucher's stock lines live in
            // tally_inventory_entries (keyed by voucher guid); a CLOUD-created
            // one's live in invoice_items. A cloud invoice that has since been
            // pushed to Tally has BOTH, so the tally side is taken only when
            // the invoice has no invoice_items — otherwise every such voucher
            // would be counted twice.
            //
            // Both branches emit an ALREADY-SIGNED amount and qty, so the outer
            // aggregate is a plain sum. They need different treatment because
            // Tally and the cloud store a return's lines differently: Tally
            // writes the credit note's line AMOUNT negative but its QTY
            // positive, while invoice_items keeps both positive and leans on
            // the voucher type for direction. Multiplying the Tally amount by
            // sgn would flip it back to positive and make Net read HIGHER than
            // Gross.
            //
            // Tally signs an inventory line by its stock DIRECTION: a sale is
            // an outflow (positive) and a purchase an inflow (negative). A
            // Purchase register must read positive, so its lines are flipped —
            // which also lands a Debit Note (goods going back out, positive in
            // Tally) on the negative side, exactly where Net wants it.
            const tallyBase = type === 'purchase' ? -1 : 1;
            const linesSql = `
                select v.id, e.item_name as item,
                       (e.qty * v.sgn) as qty,
                       (e.amount * ${tallyBase}) as amount
                  from v
                  join tally_inventory_entries e
                    on e.company_id = ? and e.voucher_guid = v.tally_guid
                 where not exists (select 1 from invoice_items ii where ii.invoice_id = v.id)
                union all
                select v.id,
                       coalesce(p.name, ii.description) as item,
                       (ii.quantity * v.sgn) as qty,
                       (ii.amount * v.sgn) as amount
                  from v
                  join invoice_items ii on ii.invoice_id = v.id
                  left join products p on p.id = ii.product_id
            `;
            let keyExpr;
            let extraJoin = '';
            if (by === 'stock_item') {
                keyExpr = "coalesce(l.item, '(No Item)')";
            } else if (by === 'stock_group') {
                // Stock Group = the item's category. Tally's stock groups sync
                // into `categories`, and the synced lines only carry the item
                // NAME, so the product master is matched by name.
                extraJoin = `
                    left join products p2 on p2.company_id = ? and lower(p2.name) = lower(l.item)
                    left join categories cat on cat.id = p2.category_id`;
                // Tally files an item that belongs to no stock group under the
                // root group "Primary" — use its name so the register reads the
                // same as Tally's own Sales Register.
                keyExpr = "coalesce(cat.name, 'Primary')";
            } else {
                // Stock Category = the category's PARENT, falling back to the
                // category itself. Tally keeps stock groups and stock
                // categories as two independent classifications; we sync only
                // the group tree, so a flat tree reports group == category.
                extraJoin = `
                    left join products p2 on p2.company_id = ? and lower(p2.name) = lower(l.item)
                    left join categories cat on cat.id = p2.category_id
                    left join categories pcat on pcat.id = cat.parent_id`;
                keyExpr = "coalesce(pcat.name, cat.name, 'Primary')";
            }
            sql = `
                with v as (${scope.sql}), l as (${linesSql})
                select ${keyExpr} as name,
                       sum(l.amount) as amount,
                       sum(l.qty) as qty,
                       count(distinct l.id) as count
                from l ${extraJoin}
                group by ${keyExpr}
                order by ${keyExpr} asc
            `;
            // linesSql's company-id bind, then the product-join's (if any).
            binds = [...binds, req.companyId];
            if (by !== 'stock_item') binds = [...binds, req.companyId];
        }

        const result = await db.raw(sql, binds);
        const rows = (result.rows || []).map((r) => ({
            name: r.name,
            amount: money(r.amount),
            qty: spec.level === 'line' ? Math.round((Number(r.qty) || 0) * 100) / 100 : null,
            count: Number(r.count) || 0,
        }));

        const grand = money(rows.reduce((s, r) => s + r.amount, 0));
        return R.successResponse(res, {
            data: rows,
            meta: {
                by, mode, label: spec.label, level: spec.level,
                grand_total: grand, groups: rows.length,
                // Grouped views are reconstructed from the vouchers themselves.
                // The MONTH register prefers Tally's own register snapshot where
                // one exists, so the two can differ slightly on historical
                // months — the UI labels this so the gap never reads as a bug.
                source: 'cloud',
                // The Stock views carry a quantity column; the header views don't.
                has_qty: spec.level === 'line',
            },
        });
    } catch (err) {
        console.error(`invoices.grouped(${type}, ${by}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function groupedSales(req, res)    { return groupedByType(req, res, 'sales'); }
async function groupedPurchase(req, res) { return groupedByType(req, res, 'purchase'); }

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const invoiceQ = baseQuery()
            .where('invoices.company_id', req.companyId)
            .whereNull('invoices.deleted_at')
            .where('invoices.id', id);
        // A location-restricted user cannot read another location's invoice by id.
        if (req.locationId != null) invoiceQ.where('invoices.location_id', req.locationId);
        // A salesman can only open an invoice THEY created.
        if (req.isSalesman) invoiceQ.where('invoices.created_by', req.user.sub);
        if (req.isCustomerUser) invoiceQ.where('invoices.customer_id', req.customerId);
        const invoice = await invoiceQ.select(...LIST_COLUMNS).first();
        if (!invoice) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('invoice_items')
            .where('company_id', req.companyId)
            .where('invoice_id', id)
            .orderBy('id', 'asc')
            .select('*');

        // Tally-synced invoices store no invoice_items — reconstruct the FULL
        // voucher (line items + ledger postings) from the entries tables, keyed
        // by the voucher GUID, so the print/view can be Tally-exact.
        let tallyItems = [];
        let tallyLedgers = [];
        if (!items.length && invoice.tally_guid) {
            // Join products (by item name) for unit + HSN + GST rate the inventory
            // entries don't carry, so the print can show Tally's per/HSN/Disc columns.
            const invEntries = await db('tally_inventory_entries as e')
                .leftJoin('products as p', function joinProd() {
                    this.on(db.raw('lower(p.name) = lower(e.item_name)'))
                        .andOn('p.company_id', '=', 'e.company_id');
                })
                .where('e.company_id', req.companyId).where('e.voucher_guid', invoice.tally_guid)
                .orderBy('e.id', 'asc')
                .select('e.item_name', 'e.qty', 'e.rate', 'e.amount', 'e.godown',
                    'p.unit', 'p.hsn_code', 'p.gst_rate');
            tallyItems = invEntries.map((e) => {
                const qty = Number(e.qty) || 0, rate = Number(e.rate) || 0, amount = Number(e.amount) || 0;
                const gross = qty * rate;
                return {
                    item_name: e.item_name, qty, rate, amount, godown: e.godown,
                    unit: e.unit || '',
                    hsn: (e.hsn_code && e.hsn_code !== 'Not Found') ? e.hsn_code : '',
                    gst_rate: Number(e.gst_rate) || 0,
                    disc_pct: gross > 0 ? Math.round(((gross - amount) / gross) * 10000) / 100 : 0,
                };
            });
            tallyLedgers = await db('tally_voucher_entries')
                .where('company_id', req.companyId).where('voucher_guid', invoice.tally_guid)
                .orderBy('id', 'asc').select('ledger_name', 'amount', 'is_debit');
        }

        // ── Derive the GST breakdown from the synced ledgers when present ──
        // Tally-synced invoices carry the tax split in tally_voucher_entries
        // (e.g. "C GST", "S GST"), NOT in invoices.cgst/sgst (often 0) — so the
        // stored taxable+tax+round wouldn't add up to the total. Recompute the
        // split from the ledgers; taxable = total − cgst − sgst − igst − round.
        if (Array.isArray(tallyLedgers) && tallyLedgers.length) {
            let cgst = 0, sgst = 0, igst = 0, roundOff = 0;
            for (const l of tallyLedgers) {
                const norm = String(l.ledger_name || '').toLowerCase().replace(/\s+/g, '');
                const amt = Number(l.amount) || 0;
                if (norm.includes('cgst')) cgst += Math.abs(amt);
                else if (norm.includes('sgst')) sgst += Math.abs(amt);
                else if (norm.includes('igst')) igst += Math.abs(amt);
                else if (norm.includes('round')) roundOff += amt;
            }
            const r2 = (n) => Math.round(n * 100) / 100;
            const total = Number(invoice.total) || 0;
            invoice.cgst       = r2(cgst);
            invoice.sgst       = r2(sgst);
            invoice.igst       = r2(igst);
            invoice.tax_amount = r2(cgst + sgst + igst);
            invoice.round_off  = r2(roundOff);
            invoice.taxable    = r2(total - cgst - sgst - igst - roundOff);
        }

        return R.successResponse(res, { ...invoice, items, tally_items: tallyItems, tally_ledgers: tallyLedgers });
    } catch (err) {
        console.error('invoices.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * Customer-portal (customers.user_id link) invoice lock-down. MUTATES `body`:
 *   • customer_id is forced to the linked customer (client value ignored).
 *   • every line MUST reference an assigned product — else returns a 422 msg.
 *   • line rate/discount from the client are IGNORED — the rate is recomputed
 *     from products.sales_price × the category's discount/addition %, so a
 *     tampered request can never buy at a made-up price.
 * Returns an error message string, or null when the body is valid + repriced.
 */
async function enforceCustomerCatalog(req, body) {
    body.customer_id = req.customerId;
    const catalog = await customerUsers.loadCatalog(req.companyId, req.customerId);
    // Payment-mode surcharge (website/API users): cash_extra_pct or
    // online_extra_pct from THEIR customer row, applied on top of the
    // category-adjusted rate. Plain customer users keep both at 0 → no-op.
    let modePct = 0;
    const mode = String(body.payment_mode || '').toLowerCase();
    if (mode === 'cash' || mode === 'online') {
        const custRow = await db('customers').where('id', req.customerId)
            .first('cash_extra_pct', 'online_extra_pct');
        if (custRow) {
            modePct = mode === 'cash'
                ? (Number(custRow.cash_extra_pct) || 0)
                : (Number(custRow.online_extra_pct) || 0);
        }
    }
    const items = body.items || [];
    const prodIds = items.map((it) => Number(it.product_id)).filter(Boolean);
    if (!prodIds.length || prodIds.length !== items.length) {
        return 'Each line must be one of your assigned products.';
    }
    const prods = await db('products')
        .where('company_id', req.companyId)
        .whereNull('deleted_at')
        .whereIn('id', prodIds)
        .select('id', 'category_id', 'sales_price', 'gst_rate', 'hsn_code', 'unit', 'name');
    const byId = new Map(prods.map((p) => [Number(p.id), p]));
    for (const it of items) {
        const p = byId.get(Number(it.product_id));
        const priced = p ? customerUsers.priceProduct(catalog, p) : { allowed: false };
        if (!priced.allowed) {
            return 'One of the products is not in your assigned catalog.';
        }
        it.rate         = modePct
            ? Math.round(priced.rate * (1 + modePct / 100) * 100) / 100
            : priced.rate;                      // locked, server-computed
        it.discount_pct = 0;                    // pricing lives in the category %
        it.gst_rate     = Number(p.gst_rate) || 0;
        if (!it.hsn)  it.hsn  = p.hsn_code || null;
        if (!it.unit) it.unit = p.unit || null;
        if (!it.description) it.description = p.name;
    }
    return null;
}

/**
 * SALES stock guard — EVERY login (admin / salesman / customer) may only sell
 * what is actually on hand: per product, the summed line qty must not exceed
 * products.opening_stock (the Tally closing balance the Inventory screen shows
 * as "current"). Lines without a product_id (free-text) are not stock-tracked.
 * `excludeInvoiceId` skips nothing today (cloud invoices don't decrement stock)
 * but keeps the signature ready for a movement ledger.
 * Returns an error message string, or null when every line fits the stock.
 */
async function checkSalesStock(req, items) {
    const need = new Map();   // product_id → total qty requested
    for (const it of items || []) {
        const pid = Number(it.product_id);
        if (!pid) continue;
        need.set(pid, (need.get(pid) || 0) + (Number(it.quantity) || 0));
    }
    if (!need.size) return null;

    // Compared against CLOSING stock — opening plus everything received, less
    // everything issued — which is the figure the Items screen and the voucher
    // form both show as "In stock". Reading products.opening_stock here meant
    // the guard enforced a number nobody could see: opening is where the item
    // STARTED, and on a synced item it is routinely 0 while the item is very
    // much on the shelf.
    const prods = await db('products as p')
        .leftJoin(db.raw(`(${MOVEMENT_SUBQUERY}) as mv`), function join() {
            this.on('mv.company_id', '=', 'p.company_id')
                .andOn(db.raw('mv.item_key = lower(p.name)'));
        })
        .where('p.company_id', req.companyId)
        .whereNull('p.deleted_at')
        .whereIn('p.id', Array.from(need.keys()))
        .select('p.id', 'p.name',
            db.raw(closingStockSql('p') + ' as closing_stock'));
    const byId = new Map(prods.map((p) => [Number(p.id), p]));

    for (const [pid, qty] of need) {
        const p = byId.get(pid);
        if (!p) continue;   // FK/catalog checks handle unknown products
        const stock = Number(p.closing_stock) || 0;
        if (qty > stock) {
            return `Not enough stock for "${p.name}" — only ${stock} available, you asked for ${qty}.`;
        }
    }
    return null;
}

/**
 * Shared create implementation. `type` is 'sales' or 'purchase'; the body has
 * already been validated by the matching Joi schema. Header + lines are written
 * inside a single transaction; invoice_no is generated under that transaction
 * so the per-company/type sequence can't race.
 */
async function createByType(req, res, type) {
    try {
        const body    = req.body;
        const isSales = type === 'sales';

        // Customer-portal login: lock the invoice to their own customer +
        // catalog at server-computed rates (see enforceCustomerCatalog).
        if (isSales && req.isCustomerUser) {
            const errMsg = await enforceCustomerCatalog(req, body);
            if (errMsg) return R.errorResponse(res, errMsg, 422);
        }
        // Stock guard: a sales line can't exceed what's on hand (every role).
        if (isSales) {
            const stockErr = await checkSalesStock(req, body.items);
            if (stockErr) return R.errorResponse(res, stockErr, 422);
        }

        const { items, totals } = computeTotals(body.items);

        // Approval + draft (SFA). EVERY non-admin user's SALES invoice needs a
        // company-admin's approval before it counts / syncs — not only linked
        // salesmen. They may Save as Draft (approval_status='draft' → editable,
        // stays OUT of the approval queue and Tally) or Submit (→ 'pending',
        // locked, enters the admin approval queue). ONLY company-admin +
        // super-admin (req.needsApproval=false) — and all purchases — go straight
        // to 'approved' (the column default backfills historical rows too).
        let approvalStatus = 'approved';
        if (isSales && req.needsApproval) {
            approvalStatus = body.save_as_draft ? 'draft' : 'pending';
        }

        // Location scoping on create: a location-restricted user can only cut
        // invoices FOR their own location — force it, ignoring any body value.
        // Unrestricted users keep their chosen/blank location_id.
        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);

        const created = await db.transaction(async (trx) => {
            // Sequence = all existing rows of this company+type (soft-deleted
            // included) + 1, so generated numbers never reuse a deleted one.
            const cntRow = await trx('invoices')
                .where('company_id', req.companyId)
                .where('type', type)
                .count('id as c')
                .first();
            const seq = Number(cntRow ? cntRow.c : 0) + 1;

            const prefix    = isSales ? 'INV' : 'PUR';
            const year      = new Date(body.invoice_date).getFullYear();
            const invoiceNo = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

            const header = {
                company_id:      req.companyId,
                type,
                invoice_no:      invoiceNo,
                location_id:     effectiveLocationId,
                customer_id:     isSales ? body.customer_id : null,
                supplier_id:     isSales ? null : body.supplier_id,
                sales_person_id: isSales
                    ? ((req.isSalesman && req.salesPersonId) ? req.salesPersonId : (body.sales_person_id || null))
                    : null,
                supplier_bill_no: isSales ? null : (body.supplier_bill_no || null),
                invoice_date:    body.invoice_date,
                due_date:        body.due_date || null,
                subtotal:        totals.subtotal,
                discount:        totals.discount,
                taxable:         totals.taxable,
                cgst:            totals.cgst,
                sgst:            totals.sgst,
                igst:            totals.igst,
                tax_amount:      totals.tax_amount,
                round_off:       totals.round_off,
                total:           totals.total,
                status:          body.status || 'pending_tally',
                payment_mode:    isSales ? (body.payment_mode || null) : null,
                approval_status: approvalStatus,
                notes:           body.notes || null,
                created_by:      req.user && req.user.sub ? req.user.sub : null,
            };

            const [invoiceRow] = await trx('invoices').insert(header).returning('*');

            const itemRows = items.map((it) => ({
                company_id: req.companyId,
                invoice_id: invoiceRow.id,
                ...it,
            }));
            const insertedItems = await trx('invoice_items').insert(itemRows).returning('*');

            return { ...invoiceRow, items: insertedItems };
        });

        // HISTORY (best-effort): a cloud-side invoice create. Header snapshot
        // only (items live in their own table); never breaks the create.
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      isSales ? 'sales-invoices' : 'purchase-invoices',
            record_type: isSales ? 'sales-invoice' : 'purchase-invoice',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        const okMsg = approvalStatus === 'draft'
            ? 'Draft saved.'
            : approvalStatus === 'pending'
                ? 'Invoice submitted for approval.'
                : 'Invoice created.';
        return R.successResponse(res, created, okMsg);
    } catch (err) {
        console.error(`invoices.create(${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function createSales(req, res) {
    return createByType(req, res, 'sales');
}

async function createPurchase(req, res) {
    return createByType(req, res, 'purchase');
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const existingQ = db('invoices')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        // A location-restricted user cannot delete another location's invoice.
        if (req.locationId != null) existingQ.where('location_id', req.locationId);
        // A non-admin (whose invoices need approval) may delete ONLY their OWN
        // invoice, and ONLY while it is still UN-APPROVED (draft / pending /
        // rejected). Once APPROVED it counts + syncs, so it is locked to them.
        // Company-admins bypass this and may delete any invoice.
        if (req.needsApproval) {
            existingQ.where('created_by', req.user.sub).whereNot('approval_status', 'approved');
        }
        const existing = await existingQ.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        // Soft delete the header only — items stay (FK CASCADE only fires on a
        // hard delete, which we never do here).
        await db('invoices').where('id', id).update({ deleted_at: now, updated_at: now });

        // HISTORY (best-effort): a cloud-side invoice delete.
        const wasSales = String(existing.type) === 'sales';
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      wasSales ? 'sales-invoices' : 'purchase-invoices',
            record_type: wasSales ? 'sales-invoice' : 'purchase-invoice',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Invoice deleted.');
    } catch (err) {
        console.error('invoices.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /sales-invoices/:id/pdf  (and /purchase-invoices/:id/pdf)
 *
 * Renders a clean, data-only invoice PDF. Reuses get()'s rich detail by calling
 * it with a capturing fake-res, then feeds the result through the shared
 * invoice renderer + Puppeteer (same pipeline as the report PDFs).
 */
async function pdf(req, res) {
    try {
        let captured = null;
        const fakeRes = {
            status() { return this; },
            json(payload) { captured = payload; return this; },
        };
        await get(req, fakeRes);
        if (!captured || captured.status !== 200 || !captured.data) {
            return R.errorResponse(res, NOT_FOUND_MSG, 404);
        }
        const inv = captured.data;
        const company = await db('companies').where('id', req.companyId).first('name');
        const { html, landscape } = invoicePdfHtml(inv, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(inv.invoice_no || inv.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="invoice-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('InvoiceController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /sales-invoices/:id/approve — a company admin approves a salesman's
 * PENDING invoice. It then counts as a real invoice AND (if it was awaiting
 * Tally) re-enters the sync queue. Salesmen cannot approve their own work.
 */
async function approve(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    if (req.isSalesman || req.isCustomerUser) return R.errorResponse(res, 'You are not allowed to approve invoices.', 403);
    try {
        const inv = await db('invoices')
            .where({ id, company_id: req.companyId, type: 'sales' })
            .whereNull('deleted_at').first();
        if (!inv) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (inv.approval_status === 'approved') {
            return R.successResponse(res, inv, 'Invoice is already approved.');
        }
        const now = new Date();
        // Re-enter the Tally sync queue on approval (unless already synced).
        const nextStatus = (inv.status === 'created' || inv.status === 'sent_to_tally')
            ? inv.status : 'pending_tally';
        const [row] = await db('invoices').where({ id, company_id: req.companyId }).update({
            approval_status: 'approved',
            approved_by:     req.user && req.user.sub ? req.user.sub : null,
            approved_at:     now,
            rejected_reason: null,
            status:          nextStatus,
            updated_at:      now,
        }).returning('*');
        await recordHistory(db, {
            company_id: req.companyId, module: 'sales-invoices', record_type: 'sales-invoice',
            record_id: id, action: 'approved', source: 'cloud',
            before: inv, after: row, changed_by: req.user ? req.user.sub : null,
        });
        return R.successResponse(res, row, 'Invoice approved.');
    } catch (err) {
        console.error('invoices.approve error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /sales-invoices/:id/reject — a company admin rejects a pending invoice
 * with a reason (shown back to the salesman). It stays out of reports + Tally.
 */
async function reject(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    if (req.isSalesman || req.isCustomerUser) return R.errorResponse(res, 'You are not allowed to reject invoices.', 403);
    const reason = String(req.body.reason || req.body.rejected_reason || '').trim();
    if (!reason) return R.errorResponse(res, 'Please give a reason for rejecting.', 422);
    try {
        const inv = await db('invoices')
            .where({ id, company_id: req.companyId, type: 'sales' })
            .whereNull('deleted_at').first();
        if (!inv) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        const now = new Date();
        const [row] = await db('invoices').where({ id, company_id: req.companyId }).update({
            approval_status: 'rejected',
            rejected_reason: reason.slice(0, 500),
            approved_by:     null,
            approved_at:     null,
            updated_at:      now,
        }).returning('*');
        await recordHistory(db, {
            company_id: req.companyId, module: 'sales-invoices', record_type: 'sales-invoice',
            record_id: id, action: 'rejected', source: 'cloud',
            before: inv, after: row, changed_by: req.user ? req.user.sub : null,
        });
        return R.successResponse(res, row, 'Invoice rejected.');
    } catch (err) {
        console.error('invoices.reject error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /sales-invoices/:id/submit — a salesman moves their own DRAFT into the
 * approval queue ('draft' → 'pending'). Once submitted it is locked to them.
 */
async function submitDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('invoices')
            .where({ id, company_id: req.companyId, type: 'sales' }).whereNull('deleted_at');
        if (req.needsApproval) q.where('created_by', req.user.sub);
        const inv = await q.first();
        if (!inv) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (inv.approval_status !== 'draft') {
            return R.errorResponse(res, 'Only a draft can be submitted.', 422);
        }
        const now = new Date();
        const [row] = await db('invoices').where({ id, company_id: req.companyId })
            .update({ approval_status: 'pending', updated_at: now }).returning('*');
        return R.successResponse(res, row, 'Invoice submitted for approval.');
    } catch (err) {
        console.error('invoices.submitDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * PUT /sales-invoices/:id — edit an invoice that is still a DRAFT (the only
 * editable state for a salesman; a submitted/approved invoice is locked). The
 * header + line items are recomputed + rewritten atomically. Passing
 * save_as_draft=false in the body ALSO submits it for approval in the same call.
 */
/**
 * PUT /purchase-invoices/:id — rewrite a purchase bill's header and lines.
 *
 * The sales counterpart is updateDraft(), which is scoped to type:'sales' and
 * enforces approval/catalog/oversell rules that do not apply to a bill you
 * RECEIVED. Totals are recomputed from the posted items by the same
 * computeTotals() create uses, so an edited bill cannot disagree with a
 * created one.
 */
async function updatePurchase(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('invoices')
            .where({ id, company_id: req.companyId, type: 'purchase' })
            .whereNull('deleted_at');
        // A location-restricted user cannot edit another location's bill.
        if (req.locationId != null) q.where('location_id', req.locationId);
        const inv = await q.first();
        if (!inv) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const { items, totals } = computeTotals(body.items);

        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                supplier_id:  body.supplier_id != null ? body.supplier_id : inv.supplier_id,
                location_id:  req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : inv.location_id),
                supplier_bill_no: body.supplier_bill_no != null ? body.supplier_bill_no : inv.supplier_bill_no,
                invoice_date: body.invoice_date || inv.invoice_date,
                due_date:     body.due_date || null,
                subtotal:  totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
                tax_amount: totals.tax_amount, round_off: totals.round_off, total: totals.total,
                notes: body.notes != null ? body.notes : inv.notes,
                updated_at: now,
            };
            await trx('invoices').where({ id, company_id: req.companyId }).update(header);
            await trx('invoice_items').where({ invoice_id: id, company_id: req.companyId }).del();
            const itemRows = items.map((it) => ({ company_id: req.companyId, invoice_id: id, ...it }));
            const insertedItems = itemRows.length
                ? await trx('invoice_items').insert(itemRows).returning('*') : [];
            const hdr = await trx('invoices').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        return R.successResponse(res, updated, 'Purchase updated.');
    } catch (err) {
        console.error('invoices.updatePurchase error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('invoices')
            .where({ id, company_id: req.companyId, type: 'sales' }).whereNull('deleted_at');
        if (req.needsApproval) q.where('created_by', req.user.sub);
        const inv = await q.first();
        if (!inv) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        // Editable while UN-APPROVED (draft / pending / rejected). Once APPROVED
        // the invoice counts + syncs to Tally, so it is locked from further edits.
        if (inv.approval_status === 'approved') {
            return R.errorResponse(res, 'This invoice is approved and locked — it can no longer be edited.', 422);
        }
        // Customer-portal login: same catalog + locked-rate enforcement as create.
        if (req.isCustomerUser) {
            const errMsg = await enforceCustomerCatalog(req, body);
            if (errMsg) return R.errorResponse(res, errMsg, 422);
        }
        // Stock guard: same as create — a draft edit can't oversell either.
        const stockErr = await checkSalesStock(req, body.items);
        if (stockErr) return R.errorResponse(res, stockErr, 422);
        const { items, totals } = computeTotals(body.items);
        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                customer_id:  body.customer_id != null ? body.customer_id : inv.customer_id,
                location_id:  req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : inv.location_id),
                invoice_date: body.invoice_date || inv.invoice_date,
                due_date:     body.due_date || null,
                subtotal:  totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst,
                tax_amount: totals.tax_amount, round_off: totals.round_off, total: totals.total,
                notes: body.notes != null ? body.notes : inv.notes,
                updated_at: now,
            };
            // "Submit" from the edit screen (save_as_draft=false) moves it out of
            // draft in the same save.
            if (body.save_as_draft === false) header.approval_status = 'pending';
            await trx('invoices').where({ id, company_id: req.companyId }).update(header);
            await trx('invoice_items').where({ invoice_id: id, company_id: req.companyId }).del();
            const itemRows = items.map((it) => ({ company_id: req.companyId, invoice_id: id, ...it }));
            const insertedItems = itemRows.length
                ? await trx('invoice_items').insert(itemRows).returning('*') : [];
            const hdr = await trx('invoices').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });
        const msg = updated.approval_status === 'pending'
            ? 'Invoice submitted for approval.' : 'Draft updated.';
        return R.successResponse(res, updated, msg);
    } catch (err) {
        console.error('invoices.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    listSales,
    listPurchase,
    monthlySales,
    monthlyPurchase,
    groupedSales,
    groupedPurchase,
    get,
    pdf,
    createSales,
    createPurchase,
    destroy,
    approve,
    reject,
    submitDraft,
    updateDraft,
    updatePurchase,
    // Reused by the recurring-invoice generator to build identical line/header math.
    computeTotals,
};
