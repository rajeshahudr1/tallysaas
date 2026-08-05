'use strict';

/**
 * api/Controllers/Tenant/QuotationController.js
 *
 * The bespoke quotations controller — mirrors InvoiceController's shape (not
 * routed through crudController) because a quotation owns a nested `items`
 * collection that must be written atomically alongside the header row, and
 * the money totals must be COMPUTED server-side (never trusted from the
 * client).
 *
 * `quotations` is its own table (not `invoices`) — a quotation has no ledger
 * / stock / GST effect until it is converted. `quote_status` tracks the deal
 * (open/accepted/rejected/expired-derived); `status` tracks the Tally sync
 * lifecycle — the two are independent.
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   (tax-inclusive line: net = net / (1+gst%)) ; gstAmt = net*gst% ;
 *   amount = net+gstAmt (each rounded to 2dp). Header totals sum the lines;
 *   cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule
 *   InvoiceController.computeTotals uses; not re-derived from customer/company
 *   state, which InvoiceController does not do either).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, convert, computeTotals }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { quotationPdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Quotation not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'quotations.*',
    'customers.name as customer',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('quotations')
        .leftJoin('customers', 'customers.id', 'quotations.customer_id')
        .leftJoin('locations', 'locations.id', 'quotations.location_id');
}

/**
 * Compute the HEADER money totals from the validated items — nothing here
 * trusts client-sent totals (any `total`/`taxable`/etc. on the incoming line
 * is simply ignored). Per line:
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   tax-inclusive line → net = net / (1 + gst%/100)  (rate already had GST in it) ;
 *   gst = net*gst% ; line total = net+gst.
 */
function computeTotals(items) {
    let subtotal = 0, discount = 0, taxable = 0, tax = 0;
    for (const it of (items || [])) {
        const qty  = Number(it.quantity) || 0;
        const rate = Number(it.rate) || 0;
        const dpct = Number(it.discount_pct) || 0;
        const gpct = Number(it.gst_rate) || 0;
        const gross = qty * rate;
        const disc  = gross * dpct / 100;
        let net = gross - disc;
        // Tax-inclusive line: rate में GST शामिल है, इसलिए उसे बाहर निकालो।
        if (it.tax_inclusive) net = net / (1 + gpct / 100);
        const gst = net * gpct / 100;
        subtotal += gross; discount += disc; taxable += net; tax += gst;
    }
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    return {
        subtotal: round2(subtotal), discount: round2(discount), taxable: round2(taxable),
        tax_amount: round2(tax), total: round2(taxable + tax),
    };
}

/**
 * Per-line rows for `quotation_items` — same math as computeTotals, kept
 * separate because computeTotals's return contract (flat header totals) is
 * consumed directly by the totals test and must not change shape.
 */
function computeItemRows(items) {
    return (items || []).map((it) => {
        const qty     = Number(it.quantity) || 0;
        const rate    = Number(it.rate) || 0;
        const discPct = Number(it.discount_pct) || 0;
        const gstRate = Number(it.gst_rate) || 0;

        const gross = money(qty * rate);
        const disc  = money(gross * (discPct / 100));
        let net = gross - disc;
        if (it.tax_inclusive) net = net / (1 + gstRate / 100);
        net = money(net);
        const gstAmt = money(net * (gstRate / 100));
        const amount = money(net + gstAmt);

        return {
            product_id:    it.product_id || null,
            description:   it.description || null,
            hsn:           it.hsn || null,
            quantity:      qty,
            unit:          it.unit || null,
            rate,
            discount_pct:  discPct,
            taxable:       net,
            gst_rate:      gstRate,
            gst_amount:    gstAmt,
            amount,
            godown:        it.godown || null,
            tax_inclusive: !!it.tax_inclusive,
        };
    });
}

// Clamp/normalise pagination from the (Joi-validated) query.
function parsePagination(query) {
    let page  = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);
    if (!Number.isInteger(page)  || page  < 1) page  = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    return { page, limit };
}

// valid_till बीत चुका और अभी तक open है → उसे expired दिखाओ। db में नहीं लिखते;
// सौदा तब भी accept हो सकता है, बस list में हालत साफ़ दिखे।
function withDerivedStatus(row, todayIso) {
    return {
        ...row,
        quote_status: (row.quote_status === 'open' && row.valid_till && new Date(row.valid_till) < new Date(todayIso))
            ? 'expired' : row.quote_status,
    };
}

async function list(req, res) {
    try {
        const { page, limit } = parsePagination(req.query);
        const search = (req.query.q || '').trim();
        const quoteStatus = (req.query.quote_status || '').trim();
        const dateFrom = req.query.from;
        const dateTo   = req.query.to;
        const mineRaw  = req.query.mine;
        const mine = mineRaw === '1' || mineRaw === 1 || mineRaw === true || mineRaw === 'true';

        let qb = baseQuery()
            .where('quotations.company_id', req.companyId)
            .whereNull('quotations.deleted_at');

        if (req.locationId != null) qb = qb.where('quotations.location_id', req.locationId);
        if (req.isSalesman || mine) qb = qb.where('quotations.created_by', req.user.sub);
        if (req.isCustomerUser) qb = qb.where('quotations.customer_id', req.customerId);

        if (quoteStatus && quoteStatus !== 'all' && quoteStatus !== 'expired') {
            qb = qb.where('quotations.quote_status', quoteStatus);
        }
        if (dateFrom) qb = qb.where('quotations.quotation_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('quotations.quotation_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('quotations.quotation_no', 'ilike', like)
                 .orWhere('customers.name', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('quotations.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        let rows = await qb
            .offset((page - 1) * limit)
            .limit(limit)
            .orderBy('quotations.id', 'desc')
            .select(...LIST_COLUMNS);

        const todayIso = new Date().toISOString().slice(0, 10);
        rows = rows.map((r) => withDerivedStatus(r, todayIso));
        // ?quote_status=expired is a DERIVED filter — apply it after deriving.
        if (quoteStatus === 'expired') rows = rows.filter((r) => r.quote_status === 'expired');

        return R.successResponse(res, { rows, total, page, limit });
    } catch (err) {
        console.error('quotations.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = baseQuery()
            .where('quotations.company_id', req.companyId)
            .whereNull('quotations.deleted_at')
            .where('quotations.id', id);
        if (req.locationId != null) q.where('quotations.location_id', req.locationId);
        if (req.isSalesman) q.where('quotations.created_by', req.user.sub);
        if (req.isCustomerUser) q.where('quotations.customer_id', req.customerId);
        const quotation = await q.select(...LIST_COLUMNS).first();
        if (!quotation) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('quotation_items')
            .where('company_id', req.companyId)
            .where('quotation_id', id)
            .orderBy('id', 'asc')
            .select('*');

        const todayIso = new Date().toISOString().slice(0, 10);
        return R.successResponse(res, { ...withDerivedStatus(quotation, todayIso), items });
    } catch (err) {
        console.error('quotations.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const body = req.body;
        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);

        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);

        const created = await db.transaction(async (trx) => {
            let quotationNo = (body.quotation_no || '').trim();
            if (!quotationNo) {
                const cntRow = await trx('quotations')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.quotation_date || Date.now()).getFullYear();
                quotationNo = `QTN-${year}-${String(seq).padStart(4, '0')}`;
            }

            const header = {
                company_id:      req.companyId,
                location_id:     effectiveLocationId,
                customer_id:     body.customer_id,
                sales_person_id: (req.isSalesman && req.salesPersonId) ? req.salesPersonId : (body.sales_person_id || null),
                quotation_no:    quotationNo,
                quotation_date:  body.quotation_date || null,
                valid_till:      body.valid_till || null,
                ledger_name:     body.ledger_name || null,
                subtotal:        totals.subtotal,
                discount:        totals.discount,
                taxable:         totals.taxable,
                cgst,
                sgst,
                igst,
                tax_amount:      totals.tax_amount,
                round_off:       0,
                total:           totals.total,
                notes:           body.notes || null,
                created_by:      req.user && req.user.sub ? req.user.sub : null,
            };

            const [quotationRow] = await trx('quotations').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id:   req.companyId,
                quotation_id: quotationRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('quotation_items').insert(rows).returning('*') : [];

            return { ...quotationRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'quotations',
            record_type: 'quotation',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Quotation created.');
    } catch (err) {
        console.error('quotations.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('quotations')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.converted_invoice_id) {
            return R.errorResponse(res, 'This quotation is already converted and can no longer be edited.', 409);
        }

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);
        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                customer_id:     body.customer_id != null ? body.customer_id : existing.customer_id,
                location_id:     req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : existing.location_id),
                sales_person_id: body.sales_person_id != null ? body.sales_person_id : existing.sales_person_id,
                quotation_date:  body.quotation_date || existing.quotation_date,
                valid_till:      body.valid_till != null ? body.valid_till : existing.valid_till,
                ledger_name:     body.ledger_name != null ? body.ledger_name : existing.ledger_name,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('quotations').where({ id, company_id: req.companyId }).update(header);
            await trx('quotation_items').where({ quotation_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, quotation_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('quotation_items').insert(rows).returning('*') : [];
            const hdr = await trx('quotations').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'quotations',
            record_type: 'quotation',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, 'Quotation updated.');
    } catch (err) {
        console.error('quotations.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('quotations')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        await db('quotations').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'quotations',
            record_type: 'quotation',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Quotation deleted.');
    } catch (err) {
        console.error('quotations.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /quotations/:id/pdf
 *
 * Renders a clean, data-only quotation PDF. Reuses get()'s rich detail by
 * calling it with a capturing fake-res, then feeds the result through the
 * shared quotation renderer + Puppeteer (same pipeline as the invoice PDF).
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
        const q = captured.data;
        const company = await db('companies').where('id', req.companyId).first('name');
        const { html, landscape } = quotationPdfHtml(q, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(q.quotation_no || q.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="quotation-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('QuotationController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* POST /quotations/:id/convert — quotation से Sales Invoice बनाता है।
 * एक ही transaction में: invoice + invoice_items बनाओ, quotation को accepted
 * करो। पहले से converted quotation पर 409 — दोबारा invoice नहीं बनेगा। */
async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = await db('quotations').where({ id, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!q) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (q.converted_invoice_id) return R.errorResponse(res, 'This quotation is already converted', 409);

        const items = await db('quotation_items')
            .where({ company_id: req.companyId, quotation_id: id })
            .orderBy('id', 'asc')
            .select('*');

        const invoiceRow = await db.transaction(async (trx) => {
            const cntRow = await trx('invoices')
                .where('company_id', req.companyId)
                .where('type', 'sales')
                .count('id as c')
                .first();
            const seq = Number(cntRow ? cntRow.c : 0) + 1;
            const year = new Date().getFullYear();
            const invoiceNo = `INV-${year}-${String(seq).padStart(4, '0')}`;

            const header = {
                company_id:      req.companyId,
                type:            'sales',
                invoice_no:      invoiceNo,
                location_id:     q.location_id,
                customer_id:     q.customer_id,
                sales_person_id: q.sales_person_id,
                invoice_date:    new Date().toISOString().slice(0, 10),
                subtotal:        q.subtotal,
                discount:        q.discount,
                taxable:         q.taxable,
                cgst:            q.cgst,
                sgst:            q.sgst,
                igst:            q.igst,
                tax_amount:      q.tax_amount,
                round_off:       q.round_off,
                total:           q.total,
                status:          'pending_tally',
                approval_status: 'approved',
                notes:           q.notes,
                created_by:      req.user && req.user.sub ? req.user.sub : null,
            };
            const [insertedInvoice] = await trx('invoices').insert(header).returning('*');

            const itemRows = items.map((it) => ({
                company_id:   req.companyId,
                invoice_id:   insertedInvoice.id,
                product_id:   it.product_id,
                description:  it.description,
                hsn:          it.hsn,
                quantity:     it.quantity,
                unit:         it.unit,
                rate:         it.rate,
                discount_pct: it.discount_pct,
                taxable:      it.taxable,
                gst_rate:     it.gst_rate,
                gst_amount:   it.gst_amount,
                amount:       it.amount,
            }));
            if (itemRows.length) await trx('invoice_items').insert(itemRows);

            const now = new Date();
            await trx('quotations').where({ id, company_id: req.companyId }).update({
                quote_status:         'accepted',
                converted_invoice_id: insertedInvoice.id,
                updated_at:           now,
            });

            return insertedInvoice;
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'quotations',
            record_type: 'quotation',
            record_id:   id,
            action:      'converted',
            source:      'cloud',
            before:      q,
            after:       { converted_invoice_id: invoiceRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { invoice_id: invoiceRow.id }, 'Converted to invoice');
    } catch (err) {
        console.error('quotations.convert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, computeTotals };
