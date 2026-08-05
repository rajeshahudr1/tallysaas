'use strict';

/**
 * api/Controllers/Tenant/DeliveryNoteController.js
 *
 * The bespoke delivery-notes controller — mirrors SalesOrderController's
 * shape (not routed through crudController) because a delivery note owns a
 * nested `items` collection that must be written atomically alongside the
 * header row, and the money totals must be COMPUTED server-side (never
 * trusted from the client).
 *
 * `delivery_notes` is its own table (not `invoices`) — a note has no ledger
 * / stock / GST effect until it is converted. A delivery note records what
 * physically LEFT the warehouse; it may optionally reference the sales order
 * it is dispatching against (`sales_order_id`), but creating/converting a
 * note NEVER mutates that order's `order_status` — partial deliveries are
 * normal, and inventing a cascade rule here would be wrong. `delivery_status`
 * tracks the note's own lifecycle (pending/invoiced/cancelled); `status`
 * tracks the Tally sync lifecycle — the two are independent.
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   (tax-inclusive line: net = net / (1+gst%)) ; gstAmt = net*gst% ;
 *   amount = net+gstAmt (each rounded to 2dp). Header totals sum the lines;
 *   cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule
 *   SalesOrderController/InvoiceController.computeTotals use; not re-derived
 *   from customer/company state, which those controllers do not do either).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, convert, computeTotals }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { deliveryNotePdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Delivery note not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'delivery_notes.*',
    'customers.name as customer',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('delivery_notes')
        .leftJoin('customers', 'customers.id', 'delivery_notes.customer_id')
        .leftJoin('locations', 'locations.id', 'delivery_notes.location_id');
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
 * Per-line rows for `delivery_note_items` — same math as computeTotals, kept
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
 * If `salesOrderId` was sent, verify it belongs to this company and is
 * "live" (not soft-deleted, not already converted, not cancelled). Returns
 * null when ok, or an error message string when it should 422.
 */
async function validateSalesOrderRef(companyId, salesOrderId) {
    if (!salesOrderId) return null;
    const order = await db('sales_orders')
        .where({ id: salesOrderId, company_id: companyId })
        .whereNull('deleted_at')
        .first();
    if (!order) return 'Selected sales order was not found.';
    if (order.converted_invoice_id) return 'Selected sales order is already converted and cannot be referenced.';
    if (order.order_status === 'cancelled') return 'Selected sales order is cancelled and cannot be referenced.';
    return null;
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        // `delivery_status` is the DELIVERY-NOTE-SPECIFIC lifecycle filter
        // (pending/invoiced/cancelled) — it targets
        // `delivery_notes.delivery_status`. It is intentionally NOT named
        // `status`: `status` is reserved app-wide for the Tally-sync
        // lifecycle, which `delivery_notes.status` also tracks independently.
        const deliveryStatus = (req.query.delivery_status || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;
        const mineRaw  = req.query.mine;
        const mine = mineRaw === '1' || mineRaw === 1 || mineRaw === true || mineRaw === 'true';

        let qb = baseQuery()
            .where('delivery_notes.company_id', req.companyId)
            .whereNull('delivery_notes.deleted_at');

        if (req.locationId != null) qb = qb.where('delivery_notes.location_id', req.locationId);
        if (req.isSalesman || mine) qb = qb.where('delivery_notes.created_by', req.user.sub);
        if (req.isCustomerUser) qb = qb.where('delivery_notes.customer_id', req.customerId);

        if (deliveryStatus && deliveryStatus !== 'all') {
            qb = qb.where('delivery_notes.delivery_status', deliveryStatus);
        }
        if (dateFrom) qb = qb.where('delivery_notes.note_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('delivery_notes.note_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('delivery_notes.note_no', 'ilike', like)
                 .orWhere('customers.name', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('delivery_notes.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('delivery_notes.id', 'desc')
            .select(...LIST_COLUMNS);

        // Shape matches SalesOrderController.list's payload: `data` is the
        // plain rows array, `meta` carries pagination — this is what the
        // shared web `apiList()` helper (web/routes/web.js) expects from
        // every list endpoint.
        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
    } catch (err) {
        console.error('deliveryNotes.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = baseQuery()
            .where('delivery_notes.company_id', req.companyId)
            .whereNull('delivery_notes.deleted_at')
            .where('delivery_notes.id', id);
        if (req.locationId != null) q.where('delivery_notes.location_id', req.locationId);
        if (req.isSalesman) q.where('delivery_notes.created_by', req.user.sub);
        if (req.isCustomerUser) q.where('delivery_notes.customer_id', req.customerId);
        const note = await q.select(...LIST_COLUMNS).first();
        if (!note) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('delivery_note_items')
            .where('company_id', req.companyId)
            .where('delivery_note_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...note, items });
    } catch (err) {
        console.error('deliveryNotes.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function create(req, res) {
    try {
        const body = req.body;

        const soErr = await validateSalesOrderRef(req.companyId, body.sales_order_id);
        if (soErr) return R.errorResponse(res, soErr, 422);

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
                const cntRow = await trx('delivery_notes')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.note_date || Date.now()).getFullYear();
                noteNo = `DN-${year}-${String(seq).padStart(4, '0')}`;
            }

            const header = {
                company_id:      req.companyId,
                location_id:     effectiveLocationId,
                customer_id:     body.customer_id,
                sales_person_id: (req.isSalesman && req.salesPersonId) ? req.salesPersonId : (body.sales_person_id || null),
                sales_order_id:  body.sales_order_id || null,
                note_no:         noteNo,
                note_date:       body.note_date || null,
                dispatch_date:   body.dispatch_date || null,
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

            const [noteRow] = await trx('delivery_notes').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id:        req.companyId,
                delivery_note_id:  noteRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('delivery_note_items').insert(rows).returning('*') : [];

            return { ...noteRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'delivery_notes',
            record_type: 'delivery_note',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Delivery note created.');
    } catch (err) {
        // A custom note_no colliding with another LIVE note for this
        // company trips delivery_notes_company_no_live_uq (partial unique
        // index — see 20260805220000_delivery_notes.js). Surface that as a
        // readable 422 instead of the generic 500 fallback.
        if (err && err.code === '23505' && /delivery_notes_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Note No "${(req.body.note_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
        console.error('deliveryNotes.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('delivery_notes')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.converted_invoice_id) {
            return R.errorResponse(res, 'This delivery note is already converted and can no longer be edited.', 409);
        }

        const soErr = await validateSalesOrderRef(req.companyId, body.sales_order_id);
        if (soErr) return R.errorResponse(res, soErr, 422);

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
                sales_order_id:  body.sales_order_id != null ? body.sales_order_id : existing.sales_order_id,
                note_date:       body.note_date || existing.note_date,
                dispatch_date:   body.dispatch_date != null ? body.dispatch_date : existing.dispatch_date,
                ledger_name:     body.ledger_name != null ? body.ledger_name : existing.ledger_name,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('delivery_notes').where({ id, company_id: req.companyId }).update(header);
            await trx('delivery_note_items').where({ delivery_note_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, delivery_note_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('delivery_note_items').insert(rows).returning('*') : [];
            const hdr = await trx('delivery_notes').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'delivery_notes',
            record_type: 'delivery_note',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, 'Delivery note updated.');
    } catch (err) {
        console.error('deliveryNotes.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('delivery_notes')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        await db('delivery_notes').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'delivery_notes',
            record_type: 'delivery_note',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Delivery note deleted.');
    } catch (err) {
        console.error('deliveryNotes.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /delivery-notes/:id/pdf
 *
 * Renders a clean, data-only delivery note PDF. Reuses get()'s rich detail by
 * calling it with a capturing fake-res, then feeds the result through the
 * shared delivery-note renderer + Puppeteer (same pipeline as the invoice/
 * sales-order PDF).
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
        const { html, landscape } = deliveryNotePdfHtml(o, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(o.note_no || o.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="delivery-note-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('DeliveryNoteController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* POST /delivery-notes/:id/convert — delivery note से Sales Invoice बनाता है।
 * एक ही transaction में: invoice + invoice_items बनाओ (type='sales', same
 * shape as InvoiceController.createByType(req, res, 'sales') for a sales
 * row), note को invoiced करो। पहले से converted note पर 409 — दोबारा invoice
 * नहीं बनेगा।
 *
 * The linked sales_order_id (if any) is NOT touched here — converting a
 * delivery note has no effect on the order's own status; partial deliveries
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
const ALREADY_CONVERTED = Symbol('delivery-note-already-converted');

async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        // Same scoping rules as get(): location + salesman (+ customer-portal)
        // restriction, so a user who cannot even view this note cannot
        // convert it either.
        const qq = baseQuery()
            .where('delivery_notes.company_id', req.companyId)
            .whereNull('delivery_notes.deleted_at')
            .where('delivery_notes.id', id);
        if (req.locationId != null) qq.where('delivery_notes.location_id', req.locationId);
        if (req.isSalesman) qq.where('delivery_notes.created_by', req.user.sub);
        if (req.isCustomerUser) qq.where('delivery_notes.customer_id', req.customerId);
        const o = await qq.select('delivery_notes.*').first();
        if (!o) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (o.converted_invoice_id) return R.errorResponse(res, 'This delivery note is already converted', 409);

        const items = await db('delivery_note_items')
            .where({ company_id: req.companyId, delivery_note_id: id })
            .orderBy('id', 'asc')
            .select('*');

        let invoiceRow;
        try {
            invoiceRow = await db.transaction(async (trx) => {
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
                location_id:     o.location_id,
                customer_id:     o.customer_id,
                sales_person_id: o.sales_person_id,
                invoice_date:    new Date().toISOString().slice(0, 10),
                subtotal:        o.subtotal,
                discount:        o.discount,
                taxable:         o.taxable,
                cgst:            o.cgst,
                sgst:            o.sgst,
                igst:            o.igst,
                tax_amount:      o.tax_amount,
                round_off:       o.round_off,
                total:           o.total,
                status:          'pending_tally',
                approval_status: 'approved',
                notes:           o.notes,
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
            // Atomic claim: only succeeds if no other request already
            // converted this note. 0 rows affected => a concurrent request
            // won the race; throw to roll back this entire transaction
            // (including the invoice/invoice_items just inserted above) so
            // this request creates NO invoice.
            const claimed = await trx('delivery_notes')
                .where({ id, company_id: req.companyId })
                .whereNull('converted_invoice_id')
                .update({
                    delivery_status:      'invoiced',
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
                return R.errorResponse(res, 'This delivery note is already converted', 409);
            }
            throw err;
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'delivery_notes',
            record_type: 'delivery_note',
            record_id:   id,
            action:      'converted',
            source:      'cloud',
            before:      o,
            after:       { converted_invoice_id: invoiceRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { invoice_id: invoiceRow.id }, 'Converted to invoice');
    } catch (err) {
        console.error('deliveryNotes.convert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, computeTotals };
