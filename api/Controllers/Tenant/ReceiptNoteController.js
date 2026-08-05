'use strict';

/**
 * api/Controllers/Tenant/ReceiptNoteController.js
 *
 * The bespoke receipt-notes controller — mirrors DeliveryNoteController's
 * shape (not routed through crudController) because a receipt note owns a
 * nested `items` collection that must be written atomically alongside the
 * header row, and the money totals must be COMPUTED server-side (never
 * trusted from the client).
 *
 * `receipt_notes` is its own table (not `invoices`) — a note has no ledger
 * / stock / GST effect until it is converted. A receipt note records what
 * physically ARRIVED at the warehouse; it may optionally reference the
 * purchase order it is receiving against (`purchase_order_id`), but
 * creating/converting a note NEVER mutates that order's `order_status` —
 * partial receipts are normal, and inventing a cascade rule here would be
 * wrong. `receipt_status` tracks the note's own lifecycle
 * (pending/invoiced/cancelled); `status` tracks the Tally sync lifecycle —
 * the two are independent.
 *
 * A receipt note's party is a SUPPLIER (`supplier_id`) — there is no
 * `sales_person_id`; receiving goods is not tied to a salesman, so (unlike
 * DeliveryNoteController) there is no `req.isSalesman` / `mine` / customer-
 * portal scoping here.
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   (tax-inclusive line: net = net / (1+gst%)) ; gstAmt = net*gst% ;
 *   amount = net+gstAmt (each rounded to 2dp). Header totals sum the lines;
 *   cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule
 *   PurchaseOrderController/InvoiceController.computeTotals use; not
 *   re-derived from supplier/company state, which those controllers do not
 *   do either).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, convert, computeTotals }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { receiptNotePdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Receipt note not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'receipt_notes.*',
    'suppliers.name as supplier',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('receipt_notes')
        .leftJoin('suppliers', 'suppliers.id', 'receipt_notes.supplier_id')
        .leftJoin('locations', 'locations.id', 'receipt_notes.location_id');
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
 * Per-line rows for `receipt_note_items` — same math as computeTotals, kept
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

// Clamp/normalise pagination from the (Joi-validated) query. Param names
// (`page`/`per_page`) match InvoiceController.parsePagination — the shared
// web `apiList()` helper (web/routes/web.js) only forwards/reads THOSE names.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_LIMIT;
    if (perPage > MAX_LIMIT) perPage = MAX_LIMIT;
    return { page, perPage };
}

/**
 * If `purchaseOrderId` was sent, verify it belongs to this company and is
 * "live" (not soft-deleted, not already converted, not cancelled). Returns
 * null when ok, or an error message string when it should 422.
 */
async function validatePurchaseOrderRef(companyId, purchaseOrderId) {
    if (!purchaseOrderId) return null;
    const order = await db('purchase_orders')
        .where({ id: purchaseOrderId, company_id: companyId })
        .whereNull('deleted_at')
        .first();
    if (!order) return 'Selected purchase order was not found.';
    if (order.converted_invoice_id) return 'Selected purchase order is already converted and cannot be referenced.';
    if (order.order_status === 'cancelled') return 'Selected purchase order is cancelled and cannot be referenced.';
    return null;
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        // `receipt_status` is the RECEIPT-NOTE-SPECIFIC lifecycle filter
        // (pending/invoiced/cancelled) — it targets
        // `receipt_notes.receipt_status`. It is intentionally NOT named
        // `status`: `status` is reserved app-wide for the Tally-sync
        // lifecycle, which `receipt_notes.status` also tracks independently.
        const receiptStatus = (req.query.receipt_status || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;

        let qb = baseQuery()
            .where('receipt_notes.company_id', req.companyId)
            .whereNull('receipt_notes.deleted_at');

        if (req.locationId != null) qb = qb.where('receipt_notes.location_id', req.locationId);

        if (receiptStatus && receiptStatus !== 'all') {
            qb = qb.where('receipt_notes.receipt_status', receiptStatus);
        }
        if (dateFrom) qb = qb.where('receipt_notes.note_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('receipt_notes.note_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('receipt_notes.note_no', 'ilike', like)
                 .orWhere('suppliers.name', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('receipt_notes.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('receipt_notes.id', 'desc')
            .select(...LIST_COLUMNS);

        // Shape matches PurchaseOrderController.list's payload: `data` is the
        // plain rows array, `meta` carries pagination — this is what the
        // shared web `apiList()` helper (web/routes/web.js) expects from
        // every list endpoint.
        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
    } catch (err) {
        console.error('receiptNotes.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = baseQuery()
            .where('receipt_notes.company_id', req.companyId)
            .whereNull('receipt_notes.deleted_at')
            .where('receipt_notes.id', id);
        if (req.locationId != null) q.where('receipt_notes.location_id', req.locationId);
        const note = await q.select(...LIST_COLUMNS).first();
        if (!note) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('receipt_note_items')
            .where('company_id', req.companyId)
            .where('receipt_note_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...note, items });
    } catch (err) {
        console.error('receiptNotes.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const body = req.body;

        const poErr = await validatePurchaseOrderRef(req.companyId, body.purchase_order_id);
        if (poErr) return R.errorResponse(res, poErr, 422);

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);

        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const effectiveLocationId = req.locationId != null
            ? req.locationId
            : (body.location_id || null);

        const created = await db.transaction(async (trx) => {
            let noteNo = (body.note_no || '').trim();
            if (!noteNo) {
                const cntRow = await trx('receipt_notes')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.note_date || Date.now()).getFullYear();
                noteNo = `RN-${year}-${String(seq).padStart(4, '0')}`;
            }

            const header = {
                company_id:         req.companyId,
                location_id:        effectiveLocationId,
                supplier_id:        body.supplier_id,
                purchase_order_id:  body.purchase_order_id || null,
                note_no:            noteNo,
                note_date:          body.note_date || null,
                received_date:      body.received_date || null,
                ledger_name:        body.ledger_name || null,
                subtotal:           totals.subtotal,
                discount:           totals.discount,
                taxable:            totals.taxable,
                cgst,
                sgst,
                igst,
                tax_amount:         totals.tax_amount,
                round_off:          0,
                total:              totals.total,
                notes:              body.notes || null,
                created_by:         req.user && req.user.sub ? req.user.sub : null,
            };

            const [noteRow] = await trx('receipt_notes').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id:      req.companyId,
                receipt_note_id: noteRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('receipt_note_items').insert(rows).returning('*') : [];

            return { ...noteRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'receipt_notes',
            record_type: 'receipt_note',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Receipt note created.');
    } catch (err) {
        // A custom note_no colliding with another LIVE note for this
        // company trips receipt_notes_company_no_live_uq (partial unique
        // index — see 20260806000000_receipt_notes.js). Surface that as a
        // readable 422 instead of the generic 500 fallback.
        if (err && err.code === '23505' && /receipt_notes_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Note No "${(req.body.note_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
        console.error('receiptNotes.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('receipt_notes')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.converted_invoice_id) {
            return R.errorResponse(res, 'This receipt note is already converted and can no longer be edited.', 409);
        }

        const poErr = await validatePurchaseOrderRef(req.companyId, body.purchase_order_id);
        if (poErr) return R.errorResponse(res, poErr, 422);

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);
        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                supplier_id:        body.supplier_id != null ? body.supplier_id : existing.supplier_id,
                location_id:        req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : existing.location_id),
                purchase_order_id:  body.purchase_order_id != null ? body.purchase_order_id : existing.purchase_order_id,
                note_date:          body.note_date || existing.note_date,
                received_date:      body.received_date != null ? body.received_date : existing.received_date,
                ledger_name:        body.ledger_name != null ? body.ledger_name : existing.ledger_name,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('receipt_notes').where({ id, company_id: req.companyId }).update(header);
            await trx('receipt_note_items').where({ receipt_note_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, receipt_note_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('receipt_note_items').insert(rows).returning('*') : [];
            const hdr = await trx('receipt_notes').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'receipt_notes',
            record_type: 'receipt_note',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, 'Receipt note updated.');
    } catch (err) {
        console.error('receiptNotes.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('receipt_notes')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        await db('receipt_notes').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'receipt_notes',
            record_type: 'receipt_note',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Receipt note deleted.');
    } catch (err) {
        console.error('receiptNotes.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /receipt-notes/:id/pdf
 *
 * Renders a clean, data-only receipt note PDF. Reuses get()'s rich detail by
 * calling it with a capturing fake-res, then feeds the result through the
 * shared receipt-note renderer + Puppeteer (same pipeline as the invoice/
 * delivery-note PDF).
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
        const o = captured.data;
        const company = await db('companies').where('id', req.companyId).first('name');
        const { html, landscape } = receiptNotePdfHtml(o, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(o.note_no || o.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="receipt-note-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('ReceiptNoteController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* POST /receipt-notes/:id/convert — receipt note से Purchase Invoice बनाता है।
 * एक ही transaction में: invoice + invoice_items बनाओ (type='purchase', same
 * shape as InvoiceController.createByType(req, res, 'purchase') for a
 * purchase row), note को invoiced करो। पहले से converted note पर 409 —
 * दोबारा invoice नहीं बनेगा।
 *
 * The linked purchase_order_id (if any) is NOT touched here — converting a
 * receipt note has no effect on the order's own status; partial receipts
 * against the same order are normal.
 *
 * Concurrency: the "is it already converted?" check and the write that
 * claims the note both happen INSIDE the same transaction, as a
 * conditional UPDATE (`WHERE id=? AND company_id=? AND
 * converted_invoice_id IS NULL`) that runs AFTER the invoice +
 * invoice_items are inserted but BEFORE the transaction commits. If that
 * update affects 0 rows, another request won the race — we throw to roll
 * the whole transaction back (undoing the invoice/invoice_items insert too,
 * so the loser creates NO invoice at all) and report 409. */
const ALREADY_CONVERTED = Symbol('receipt-note-already-converted');

async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        // Same scoping rules as get(): location restriction, so a user who
        // cannot even view this note cannot convert it either.
        const qq = baseQuery()
            .where('receipt_notes.company_id', req.companyId)
            .whereNull('receipt_notes.deleted_at')
            .where('receipt_notes.id', id);
        if (req.locationId != null) qq.where('receipt_notes.location_id', req.locationId);
        const o = await qq.select('receipt_notes.*').first();
        if (!o) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (o.converted_invoice_id) return R.errorResponse(res, 'This receipt note is already converted', 409);

        const items = await db('receipt_note_items')
            .where({ company_id: req.companyId, receipt_note_id: id })
            .orderBy('id', 'asc')
            .select('*');

        let invoiceRow;
        try {
            invoiceRow = await db.transaction(async (trx) => {
            const cntRow = await trx('invoices')
                .where('company_id', req.companyId)
                .where('type', 'purchase')
                .count('id as c')
                .first();
            const seq = Number(cntRow ? cntRow.c : 0) + 1;
            const year = new Date().getFullYear();
            const invoiceNo = `PUR-${year}-${String(seq).padStart(4, '0')}`;

            const header = {
                company_id:       req.companyId,
                type:             'purchase',
                invoice_no:       invoiceNo,
                location_id:      o.location_id,
                customer_id:      null,
                supplier_id:      o.supplier_id,
                sales_person_id:  null,
                supplier_bill_no: null,
                invoice_date:     new Date().toISOString().slice(0, 10),
                subtotal:         o.subtotal,
                discount:         o.discount,
                taxable:          o.taxable,
                cgst:             o.cgst,
                sgst:             o.sgst,
                igst:             o.igst,
                tax_amount:       o.tax_amount,
                round_off:        o.round_off,
                total:            o.total,
                status:           'pending_tally',
                payment_mode:     null,
                approval_status:  'approved',
                notes:            o.notes,
                created_by:       req.user && req.user.sub ? req.user.sub : null,
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
            // Atomic claim: only succeeds if no other request already
            // converted this note. 0 rows affected => a concurrent request
            // won the race; throw to roll back this entire transaction
            // (including the invoice/invoice_items just inserted above) so
            // this request creates NO invoice.
            const claimed = await trx('receipt_notes')
                .where({ id, company_id: req.companyId })
                .whereNull('converted_invoice_id')
                .update({
                    receipt_status:       'invoiced',
                    converted_invoice_id: insertedInvoice.id,
                    updated_at:           now,
                });
            if (!claimed) {
                throw ALREADY_CONVERTED;
            }

            return insertedInvoice;
            });
        } catch (err) {
            if (err === ALREADY_CONVERTED) {
                return R.errorResponse(res, 'This receipt note is already converted', 409);
            }
            throw err;
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'receipt_notes',
            record_type: 'receipt_note',
            record_id:   id,
            action:      'converted',
            source:      'cloud',
            before:      o,
            after:       { converted_invoice_id: invoiceRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { invoice_id: invoiceRow.id }, 'Converted to invoice');
    } catch (err) {
        console.error('receiptNotes.convert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, computeTotals };
