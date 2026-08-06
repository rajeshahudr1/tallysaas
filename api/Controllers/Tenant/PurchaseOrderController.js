'use strict';

/**
 * api/Controllers/Tenant/PurchaseOrderController.js
 *
 * The bespoke purchase-orders controller — mirrors SalesOrderController's
 * shape (not routed through crudController) because a purchase order owns a
 * nested `items` collection that must be written atomically alongside the
 * header row, and the money totals must be COMPUTED server-side (never
 * trusted from the client).
 *
 * `purchase_orders` is its own table (not `invoices`) — an order has no
 * ledger / stock / GST effect until it is converted. `order_status` tracks
 * delivery progress (pending/partially_delivered/delivered/cancelled);
 * `status` tracks the Tally sync lifecycle — the two are independent.
 *
 * A purchase order's party is a SUPPLIER (`supplier_id`) — there is no
 * `sales_person_id`; purchasing is not tied to a salesman, so (unlike
 * SalesOrderController) there is no `req.isSalesman` / `mine` / customer-
 * portal scoping here.
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   (tax-inclusive line: net = net / (1+gst%)) ; gstAmt = net*gst% ;
 *   amount = net+gstAmt (each rounded to 2dp). Header totals sum the lines;
 *   cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule
 *   SalesOrderController/InvoiceController.computeTotals use; not re-derived
 *   from supplier/company state, which those controllers do not do either).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, convert, computeTotals }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { purchaseOrderPdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Purchase order not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'purchase_orders.*',
    'suppliers.name as supplier',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('purchase_orders')
        .leftJoin('suppliers', 'suppliers.id', 'purchase_orders.supplier_id')
        .leftJoin('locations', 'locations.id', 'purchase_orders.location_id');
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
 * Per-line rows for `purchase_order_items` — same math as computeTotals, kept
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

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        // `order_status` is the PURCHASE-ORDER-SPECIFIC delivery-lifecycle
        // filter (pending/partially_delivered/delivered/cancelled) — it
        // targets `purchase_orders.order_status`. It is intentionally NOT
        // named `status`: `status` is reserved app-wide for the Tally-sync
        // lifecycle, which `purchase_orders.status` also tracks independently.
        const orderStatus = (req.query.order_status || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;

        let qb = baseQuery()
            .where('purchase_orders.company_id', req.companyId)
            .whereNull('purchase_orders.deleted_at');

        if (req.locationId != null) qb = qb.where('purchase_orders.location_id', req.locationId);

        if (orderStatus && orderStatus !== 'all') {
            qb = qb.where('purchase_orders.order_status', orderStatus);
        }
        if (dateFrom) qb = qb.where('purchase_orders.order_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('purchase_orders.order_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('purchase_orders.order_no', 'ilike', like)
                 .orWhere('suppliers.name', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('purchase_orders.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('purchase_orders.id', 'desc')
            .select(...LIST_COLUMNS);

        // Shape matches SalesOrderController.list's payload: `data` is the
        // plain rows array, `meta` carries pagination — this is what the
        // shared web `apiList()` helper (web/routes/web.js) expects from
        // every list endpoint.
        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
    } catch (err) {
        console.error('purchaseOrders.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = baseQuery()
            .where('purchase_orders.company_id', req.companyId)
            .whereNull('purchase_orders.deleted_at')
            .where('purchase_orders.id', id);
        if (req.locationId != null) q.where('purchase_orders.location_id', req.locationId);
        const order = await q.select(...LIST_COLUMNS).first();
        if (!order) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('purchase_order_items')
            .where('company_id', req.companyId)
            .where('purchase_order_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...order, items });
    } catch (err) {
        console.error('purchaseOrders.get error:', err);
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
            let orderNo = (body.order_no || '').trim();
            if (!orderNo) {
                const cntRow = await trx('purchase_orders')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.order_date || Date.now()).getFullYear();
                orderNo = `PO-${year}-${String(seq).padStart(4, '0')}`;
            }

            const header = {
                company_id:      req.companyId,
                location_id:     effectiveLocationId,
                supplier_id:     body.supplier_id,
                order_no:        orderNo,
                order_date:      body.order_date || null,
                due_on:          body.due_on || null,
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
                // Ready to sync as soon as it's saved (see QuotationController.create).
                status:          'pending_tally',
            };

            const [orderRow] = await trx('purchase_orders').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id:        req.companyId,
                purchase_order_id: orderRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('purchase_order_items').insert(rows).returning('*') : [];

            return { ...orderRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'purchase_orders',
            record_type: 'purchase_order',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Purchase order created.');
    } catch (err) {
        // A custom order_no colliding with another LIVE order for this
        // company trips purchase_orders_company_no_live_uq (partial unique
        // index — see 20260805200000_purchase_orders.js). Surface that as a
        // readable 422 instead of the generic 500 fallback.
        if (err && err.code === '23505' && /purchase_orders_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Order No "${(req.body.order_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
        console.error('purchaseOrders.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('purchase_orders')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.converted_invoice_id) {
            return R.errorResponse(res, 'This purchase order is already converted and can no longer be edited.', 409);
        }

        const itemRows = computeItemRows(body.items);
        const totals = computeTotals(body.items);
        const cgst = money(totals.tax_amount / 2);
        const sgst = money(totals.tax_amount / 2);
        const igst = 0;

        const updated = await db.transaction(async (trx) => {
            const now = new Date();
            const header = {
                supplier_id:     body.supplier_id != null ? body.supplier_id : existing.supplier_id,
                location_id:     req.locationId != null
                    ? req.locationId
                    : (body.location_id != null ? body.location_id : existing.location_id),
                order_date:      body.order_date || existing.order_date,
                due_on:          body.due_on != null ? body.due_on : existing.due_on,
                ledger_name:     body.ledger_name != null ? body.ledger_name : existing.ledger_name,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('purchase_orders').where({ id, company_id: req.companyId }).update(header);
            await trx('purchase_order_items').where({ purchase_order_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, purchase_order_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('purchase_order_items').insert(rows).returning('*') : [];
            const hdr = await trx('purchase_orders').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'purchase_orders',
            record_type: 'purchase_order',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, 'Purchase order updated.');
    } catch (err) {
        console.error('purchaseOrders.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('purchase_orders')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        await db('purchase_orders').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'purchase_orders',
            record_type: 'purchase_order',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Purchase order deleted.');
    } catch (err) {
        console.error('purchaseOrders.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /purchase-orders/:id/pdf
 *
 * Renders a clean, data-only purchase order PDF. Reuses get()'s rich detail
 * by calling it with a capturing fake-res, then feeds the result through the
 * shared purchase-order renderer + Puppeteer (same pipeline as the invoice/
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
        const { html, landscape } = purchaseOrderPdfHtml(o, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(o.order_no || o.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="purchase-order-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('PurchaseOrderController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* POST /purchase-orders/:id/convert — purchase order से Purchase Invoice बनाता
 * है। एक ही transaction में: invoice + invoice_items बनाओ, order को delivered
 * करो। पहले से converted order पर 409 — दोबारा invoice नहीं बनेगा।
 *
 * Invoice shape mirrors InvoiceController.createByType(req, res, 'purchase')
 * for a purchase row: type='purchase', supplier_id (no customer_id / no
 * sales_person_id / no payment_mode), supplier_bill_no null (an order has no
 * supplier bill yet), invoice_no prefixed 'PUR-', approval_status 'approved'
 * (purchases skip the sales approval workflow, same as InvoiceController).
 *
 * Concurrency: the "is it already converted?" check and the write that
 * claims the order both happen INSIDE the same transaction, as a
 * conditional UPDATE (`WHERE id=? AND company_id=? AND
 * converted_invoice_id IS NULL`) that runs AFTER the invoice +
 * invoice_items are inserted but BEFORE the transaction commits. If that
 * update affects 0 rows, another request won the race — we throw to roll
 * the whole transaction back (undoing the invoice/invoice_items insert too,
 * so the loser creates NO invoice at all) and report 409. */
const ALREADY_CONVERTED = Symbol('purchase-order-already-converted');

async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        // Same scoping rules as get(): location restriction, so a user who
        // cannot even view this order cannot convert it either.
        const qq = baseQuery()
            .where('purchase_orders.company_id', req.companyId)
            .whereNull('purchase_orders.deleted_at')
            .where('purchase_orders.id', id);
        if (req.locationId != null) qq.where('purchase_orders.location_id', req.locationId);
        const o = await qq.select('purchase_orders.*').first();
        if (!o) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (o.converted_invoice_id) return R.errorResponse(res, 'This purchase order is already converted', 409);

        const items = await db('purchase_order_items')
            .where({ company_id: req.companyId, purchase_order_id: id })
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
            // converted this order. 0 rows affected => a concurrent request
            // won the race; throw to roll back this entire transaction
            // (including the invoice/invoice_items just inserted above) so
            // this request creates NO invoice.
            const claimed = await trx('purchase_orders')
                .where({ id, company_id: req.companyId })
                .whereNull('converted_invoice_id')
                .update({
                    order_status:         'delivered',
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
                return R.errorResponse(res, 'This purchase order is already converted', 409);
            }
            throw err;
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'purchase_orders',
            record_type: 'purchase_order',
            record_id:   id,
            action:      'converted',
            source:      'cloud',
            before:      o,
            after:       { converted_invoice_id: invoiceRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { invoice_id: invoiceRow.id }, 'Converted to invoice');
    } catch (err) {
        console.error('purchaseOrders.convert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, computeTotals };
