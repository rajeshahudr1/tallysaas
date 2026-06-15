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

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('invoices.id', 'desc')
            .select(...LIST_COLUMNS);

        return R.successResponse(res, {
            data: rows,
            meta: { total, page, per_page: perPage },
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

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const invoice = await baseQuery()
            .where('invoices.company_id', req.companyId)
            .whereNull('invoices.deleted_at')
            .where('invoices.id', id)
            .select(...LIST_COLUMNS)
            .first();
        if (!invoice) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('invoice_items')
            .where('company_id', req.companyId)
            .where('invoice_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...invoice, items });
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
                location_id:     body.location_id || null,
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
        const existing = await db('invoices')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id)
            .first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        // Soft delete the header only — items stay (FK CASCADE only fires on a
        // hard delete, which we never do here).
        await db('invoices').where('id', id).update({ deleted_at: now, updated_at: now });

        return R.successResponse(res, { id }, 'Invoice deleted.');
    } catch (err) {
        console.error('invoices.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    listSales,
    listPurchase,
    get,
    createSales,
    createPurchase,
    destroy,
};
