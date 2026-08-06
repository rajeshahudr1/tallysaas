'use strict';

/**
 * api/Controllers/Tenant/ReturnNoteController.js
 *
 * Credit Note / Debit Note controller. Structurally this follows
 * DeliveryNoteController's shape (bespoke, not routed through crudController,
 * because a note owns a nested `items` collection written atomically with the
 * header, and money totals are COMPUTED server-side — never trusted from the
 * client).
 *
 * DATA-side it is unlike every other voucher module: it creates NO new
 * table. Credit/Debit Notes already live in the shared `invoices` table —
 * Tally syncs them there as type='sales'+tally_voucher_type='Credit Note'
 * (sales returns) and type='purchase'+tally_voucher_type='Debit Note'
 * (purchase returns). InvoiceController.excludeReturns() is what keeps
 * these rows OUT of the plain sales/purchase invoice lists — see that
 * function's comment. This controller is the mirror: it shows ONLY rows
 * matching (type, tally_voucher_type) for its `kind`, whether they came
 * from Tally (tally_guid set) or were created here (tally_guid null).
 *
 * `kind` is 'credit' | 'debit' — every handler is parameterised on it via
 * the small VOUCHER_TYPE / INVOICE_TYPE maps below, then wired twice in
 * Routes/index.js (once per kind), same pattern as
 * InvoiceController.listSales/listPurchase wrapping listByType.
 *
 * A row synced FROM Tally (tally_guid set) is Tally's property — editing or
 * deleting it here would make the two systems disagree about what happened,
 * so updateDraft/destroy 409 on it with a clear message.
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; taxable = gross-discAmt ;
 *   (tax-inclusive line: taxable = taxable / (1+gst%)) ; gstAmt = taxable*gst% ;
 *   amount = taxable+gstAmt (each rounded to 2dp). Header totals sum the
 *   lines; cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule every
 *   other module in this project uses).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, computeTotals,
 *            VOUCHER_TYPE, INVOICE_TYPE }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { returnNotePdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// kind -> exact Tally voucher-type string / invoices.type — see the module
// header comment. Frozen so a stray write can't drift them apart from what
// Tally actually sends.
const VOUCHER_TYPE = Object.freeze({ credit: 'Credit Note', debit: 'Debit Note' });
const INVOICE_TYPE = Object.freeze({ credit: 'sales', debit: 'purchase' });

function notFoundMsg(kind) {
    return kind === 'credit' ? 'Credit note not found.' : 'Debit note not found.';
}
function labelOf(kind) {
    return kind === 'credit' ? 'Credit note' : 'Debit note';
}

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('invoices')
        .leftJoin('customers', 'customers.id', 'invoices.customer_id')
        .leftJoin('suppliers', 'suppliers.id', 'invoices.supplier_id')
        .leftJoin('locations', 'locations.id', 'invoices.location_id');
}

const LIST_COLUMNS = [
    'invoices.*',
    'customers.name as customer',
    'suppliers.name as supplier',
    'locations.name as location',
];

/**
 * Compute the HEADER money totals from the validated items — nothing here
 * trusts client-sent totals (any `total`/`taxable`/etc. on the incoming line
 * is simply ignored). Same math as DeliveryNoteController.computeTotals /
 * InvoiceController.computeTotals.
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
 * Per-line rows for `invoice_items` — same math as computeTotals, kept
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
            product_id:   it.product_id || null,
            description:  it.description || null,
            hsn:          it.hsn || null,
            quantity:     qty,
            unit:         it.unit || null,
            rate,
            discount_pct: discPct,
            taxable:      net,
            gst_rate:     gstRate,
            gst_amount:   gstAmt,
            amount,
        };
    });
}

// Clamp/normalise pagination from the (Joi-validated) query. Param names
// match InvoiceController.parsePagination / DeliveryNoteController's — the
// shared web `apiList()` helper only forwards/reads THOSE names.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_LIMIT;
    if (perPage > MAX_LIMIT) perPage = MAX_LIMIT;
    return { page, perPage };
}

/**
 * If `againstInvoiceId` was sent, verify it belongs to this company, is
 * live (not soft-deleted), and is the SAME invoices.type as `kind` maps to
 * (a credit note against a sales invoice, a debit note against a purchase
 * invoice). Returns null when ok, or an error message string for a 422.
 */
async function validateAgainstInvoice(companyId, kind, againstInvoiceId) {
    if (!againstInvoiceId) return null;
    const type = INVOICE_TYPE[kind];
    const inv = await db('invoices')
        .where({ id: againstInvoiceId, company_id: companyId, type })
        .whereNull('deleted_at')
        .first();
    if (!inv) return 'Selected original bill was not found.';
    return null;
}

async function list(req, res) {
    const kind = req.returnNoteKind;
    try {
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;
        const type        = INVOICE_TYPE[kind];
        const voucherType = VOUCHER_TYPE[kind];
        const isSales      = type === 'sales';
        const partyName = isSales ? 'customers.name' : 'suppliers.name';

        let qb = baseQuery()
            .where('invoices.company_id', req.companyId)
            .where('invoices.type', type)
            .where('invoices.tally_voucher_type', voucherType)
            .whereNull('invoices.deleted_at');

        if (req.locationId != null) qb = qb.where('invoices.location_id', req.locationId);
        if (req.isSalesman) qb = qb.where('invoices.created_by', req.user.sub);
        if (req.isCustomerUser) qb = qb.where('invoices.customer_id', req.customerId);

        if (dateFrom) qb = qb.where('invoices.invoice_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('invoices.invoice_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('invoices.invoice_no', 'ilike', like)
                 .orWhere(partyName, 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('invoices.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('invoices.id', 'desc')
            .select(...LIST_COLUMNS);

        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
    } catch (err) {
        console.error(`returnNotes.list(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const kind = req.returnNoteKind;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFoundMsg(kind), 404);
    try {
        const type        = INVOICE_TYPE[kind];
        const voucherType = VOUCHER_TYPE[kind];
        const q = baseQuery()
            .where('invoices.company_id', req.companyId)
            .where('invoices.type', type)
            .where('invoices.tally_voucher_type', voucherType)
            .whereNull('invoices.deleted_at')
            .where('invoices.id', id);
        if (req.locationId != null) q.where('invoices.location_id', req.locationId);
        if (req.isSalesman) q.where('invoices.created_by', req.user.sub);
        if (req.isCustomerUser) q.where('invoices.customer_id', req.customerId);
        const note = await q.select(...LIST_COLUMNS).first();
        if (!note) return R.errorResponse(res, notFoundMsg(kind), 404);

        const items = await db('invoice_items')
            .where('company_id', req.companyId)
            .where('invoice_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...note, items });
    } catch (err) {
        console.error(`returnNotes.get(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    const kind = req.returnNoteKind;
    try {
        const body    = req.body;
        const type    = INVOICE_TYPE[kind];
        const isSales = type === 'sales';

        const partyId = isSales ? body.customer_id : body.supplier_id;
        if (!partyId) {
            return R.errorResponse(res, isSales ? 'Customer is required.' : 'Supplier is required.', 422);
        }

        const againstErr = await validateAgainstInvoice(req.companyId, kind, body.against_invoice_id);
        if (againstErr) return R.errorResponse(res, againstErr, 422);

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);

        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);

        const created = await db.transaction(async (trx) => {
            const cntRow = await trx('invoices')
                .where('company_id', req.companyId)
                .where('type', type)
                .count('id as c')
                .first();
            const seq = Number(cntRow ? cntRow.c : 0) + 1;
            // Distinct prefix from ordinary invoices (INV-/PUR-) so a note can
            // never collide with uq_invoices_cloud_no (company_id, type,
            // invoice_no) — CN- for a Credit Note, DBN- for a Debit Note.
            const prefix = kind === 'credit' ? 'CN' : 'DBN';
            const year   = new Date(body.invoice_date || Date.now()).getFullYear();
            const invoiceNo = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

            const header = {
                company_id:         req.companyId,
                type,
                invoice_no:         invoiceNo,
                location_id:        effectiveLocationId,
                customer_id:        isSales ? partyId : null,
                supplier_id:        isSales ? null : partyId,
                supplier_bill_no:   isSales ? null : (body.supplier_bill_no || null),
                invoice_date:       body.invoice_date || null,
                subtotal:           totals.subtotal,
                discount:           totals.discount,
                taxable:            totals.taxable,
                cgst,
                sgst,
                igst,
                tax_amount:         totals.tax_amount,
                round_off:          0,
                total:              totals.total,
                status:             'pending_tally',
                tally_voucher_type: VOUCHER_TYPE[kind],
                tally_optional:     false,
                approval_status:    'approved',
                against_invoice_id: body.against_invoice_id || null,
                notes:              body.notes || null,
                created_by:         req.user && req.user.sub ? req.user.sub : null,
            };

            const [invoiceRow] = await trx('invoices').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id: req.companyId,
                invoice_id: invoiceRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('invoice_items').insert(rows).returning('*') : [];

            return { ...invoiceRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      kind === 'credit' ? 'credit-notes' : 'debit-notes',
            record_type: kind === 'credit' ? 'credit-note' : 'debit-note',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, `${labelOf(kind)} created.`);
    } catch (err) {
        if (err && err.code === '23505' && /uq_invoices_cloud_no/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, 'That note number is already in use. Please try again.', 422);
        }
        console.error(`returnNotes.create(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const kind = req.returnNoteKind;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFoundMsg(kind), 404);
    const body = req.body;
    try {
        const type    = INVOICE_TYPE[kind];
        const isSales = type === 'sales';

        const q = db('invoices')
            .where({ id, company_id: req.companyId, type, tally_voucher_type: VOUCHER_TYPE[kind] })
            .whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, notFoundMsg(kind), 404);

        // A row synced FROM Tally is Tally's property — editing it here would
        // make the two systems disagree about what happened.
        if (existing.tally_guid) {
            return R.errorResponse(res, `This ${labelOf(kind).toLowerCase()} was synced from Tally and cannot be edited here.`, 409);
        }

        const partyId = isSales
            ? (body.customer_id != null ? body.customer_id : existing.customer_id)
            : (body.supplier_id != null ? body.supplier_id : existing.supplier_id);
        if (!partyId) {
            return R.errorResponse(res, isSales ? 'Customer is required.' : 'Supplier is required.', 422);
        }

        const againstInvoiceId = body.against_invoice_id !== undefined
            ? body.against_invoice_id
            : existing.against_invoice_id;
        const againstErr = await validateAgainstInvoice(req.companyId, kind, againstInvoiceId);
        if (againstErr) return R.errorResponse(res, againstErr, 422);

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);
        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                customer_id:  isSales ? partyId : null,
                supplier_id:  isSales ? null : partyId,
                location_id:  req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : existing.location_id),
                supplier_bill_no:   isSales ? null : (body.supplier_bill_no != null ? body.supplier_bill_no : existing.supplier_bill_no),
                invoice_date:       body.invoice_date || existing.invoice_date,
                against_invoice_id: againstInvoiceId || null,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('invoices').where({ id, company_id: req.companyId }).update(header);
            await trx('invoice_items').where({ invoice_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, invoice_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('invoice_items').insert(rows).returning('*') : [];
            const hdr = await trx('invoices').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      kind === 'credit' ? 'credit-notes' : 'debit-notes',
            record_type: kind === 'credit' ? 'credit-note' : 'debit-note',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, `${labelOf(kind)} updated.`);
    } catch (err) {
        console.error(`returnNotes.updateDraft(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const kind = req.returnNoteKind;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFoundMsg(kind), 404);
    try {
        const type = INVOICE_TYPE[kind];
        const q = db('invoices')
            .where('company_id', req.companyId)
            .where('type', type)
            .where('tally_voucher_type', VOUCHER_TYPE[kind])
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, notFoundMsg(kind), 404);

        // A row synced FROM Tally is Tally's property — deleting it here would
        // make the two systems disagree about what happened.
        if (existing.tally_guid) {
            return R.errorResponse(res, `This ${labelOf(kind).toLowerCase()} was synced from Tally and cannot be deleted here.`, 409);
        }

        const now = new Date();
        await db('invoices').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      kind === 'credit' ? 'credit-notes' : 'debit-notes',
            record_type: kind === 'credit' ? 'credit-note' : 'debit-note',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, `${labelOf(kind)} deleted.`);
    } catch (err) {
        console.error(`returnNotes.destroy(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /credit-notes/:id/pdf and /debit-notes/:id/pdf
 *
 * Renders a clean, data-only note PDF. Reuses get()'s rich detail by calling
 * it with a capturing fake-res, then feeds the result through the shared
 * return-note renderer + Puppeteer (same pipeline as the invoice/delivery-
 * note PDF).
 */
async function pdf(req, res) {
    const kind = req.returnNoteKind;
    try {
        let captured = null;
        const fakeRes = {
            status() { return this; },
            json(payload) { captured = payload; return this; },
        };
        await get(req, fakeRes);
        if (!captured || captured.status !== 200 || !captured.data) {
            return R.errorResponse(res, notFoundMsg(kind), 404);
        }
        const o = captured.data;
        const company = await db('companies').where('id', req.companyId).first('name');
        const { html, landscape } = returnNotePdfHtml(o, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        }, kind);
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(o.invoice_no || o.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${kind}-note-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error(`ReturnNoteController.pdf(${kind}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list, get, create, updateDraft, destroy, pdf,
    computeTotals,
    VOUCHER_TYPE,
    INVOICE_TYPE,
};
