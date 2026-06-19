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
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');

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

        if (status)   qb = qb.where('invoices.status', status);
        if (partyId)  qb = qb.where(partyCol, partyId);
        if (dateFrom) qb = qb.where('invoices.invoice_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('invoices.invoice_date', '<=', dateTo);

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

        return R.successResponse(res, {
            data: rows,
            meta: { total, page, per_page: perPage, grand_total: grandTotal },
        });
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
async function monthlyByType(req, res, type) {
    try {
        let qb = db('invoices')
            .where('invoices.company_id', req.companyId)
            .where('invoices.type', type)
            .whereNull('invoices.deleted_at');
        if (req.locationId != null) qb = qb.where('invoices.location_id', req.locationId);
        if (req.query.date_from) qb = qb.where('invoices.invoice_date', '>=', req.query.date_from);
        if (req.query.date_to)   qb = qb.where('invoices.invoice_date', '<=', req.query.date_to);
        qb = excludeReturns(qb, type);

        const rows = await qb
            .select(db.raw("to_char(invoices.invoice_date, 'YYYY-MM') as month"))
            .sum('invoices.total as total')
            .count('invoices.id as count')
            .groupByRaw("to_char(invoices.invoice_date, 'YYYY-MM')")
            .orderByRaw("to_char(invoices.invoice_date, 'YYYY-MM')");

        let running = 0;
        const months = rows.map((r) => {
            running += Number(r.total) || 0;
            return {
                month:   r.month,
                total:   money(r.total),
                count:   Number(r.count) || 0,
                closing: money(running),
            };
        });
        return R.successResponse(res, {
            data: months,
            meta: { grand_total: money(running), months: months.length },
        });
    } catch (err) {
        console.error(`invoices.monthly(${type}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function monthlySales(req, res)    { return monthlyByType(req, res, 'sales'); }
async function monthlyPurchase(req, res) { return monthlyByType(req, res, 'purchase'); }

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

        return R.successResponse(res, { ...invoice, items, tally_items: tallyItems, tally_ledgers: tallyLedgers });
    } catch (err) {
        console.error('invoices.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
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
        const { items, totals } = computeTotals(body.items);

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
                sales_person_id: isSales ? (body.sales_person_id || null) : null,
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

        return R.successResponse(res, created, 'Invoice created.');
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

module.exports = {
    listSales,
    listPurchase,
    monthlySales,
    monthlyPurchase,
    get,
    createSales,
    createPurchase,
    destroy,
};
