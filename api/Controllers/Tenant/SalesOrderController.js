'use strict';

/**
 * api/Controllers/Tenant/SalesOrderController.js
 *
 * The bespoke sales-orders controller — mirrors QuotationController's shape
 * (not routed through crudController) because a sales order owns a nested
 * `items` collection that must be written atomically alongside the header
 * row, and the money totals must be COMPUTED server-side (never trusted from
 * the client).
 *
 * `sales_orders` is its own table (not `invoices`) — an order has no ledger
 * / stock / GST effect until it is converted. `order_status` tracks delivery
 * progress (pending/partially_delivered/delivered/cancelled); `status`
 * tracks the Tally sync lifecycle — the two are independent. Unlike
 * quotation's `quote_status`, `order_status` is a real column with no
 * derived-at-read-time behaviour (no "expired" style trick).
 *
 * Money math (authoritative — see computeTotals): per line
 *   gross = qty*rate ; discAmt = gross*disc% ; net = gross-discAmt ;
 *   (tax-inclusive line: net = net / (1+gst%)) ; gstAmt = net*gst% ;
 *   amount = net+gstAmt (each rounded to 2dp). Header totals sum the lines;
 *   cgst=sgst=tax/2, igst=0 (intra-state assumption — same rule
 *   QuotationController/InvoiceController.computeTotals use; not re-derived
 *   from customer/company state, which those controllers do not do either).
 *
 * Exports: { list, get, create, updateDraft, destroy, pdf, convert, computeTotals }
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');
const { htmlToPdf } = require('../../Helpers/pdf');
const { salesOrderPdfHtml } = require('../../Helpers/transactionPdf');

const OOPS_MSG      = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND_MSG = 'Sales order not found.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 100;

// SELECT columns for list/get — base table plus friendly party / location labels.
const LIST_COLUMNS = [
    'sales_orders.*',
    'customers.name as customer',
    'locations.name as location',
];

// Round a money value to 2 decimals (numeric(_,2) columns).
function money(x) {
    return Number(Number(x).toFixed(2));
}

function baseQuery() {
    return db('sales_orders')
        .leftJoin('customers', 'customers.id', 'sales_orders.customer_id')
        .leftJoin('locations', 'locations.id', 'sales_orders.location_id');
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
 * Per-line rows for `sales_order_items` — same math as computeTotals, kept
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
        // `order_status` is the SALES-ORDER-SPECIFIC delivery-lifecycle
        // filter (pending/partially_delivered/delivered/cancelled) — it
        // targets `sales_orders.order_status`. It is intentionally NOT named
        // `status`: `status` is reserved app-wide for the Tally-sync
        // lifecycle, which `sales_orders.status` also tracks independently.
        const orderStatus = (req.query.order_status || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;
        const mineRaw  = req.query.mine;
        const mine = mineRaw === '1' || mineRaw === 1 || mineRaw === true || mineRaw === 'true';

        let qb = baseQuery()
            .where('sales_orders.company_id', req.companyId)
            .whereNull('sales_orders.deleted_at');

        if (req.locationId != null) qb = qb.where('sales_orders.location_id', req.locationId);
        if (req.isSalesman || mine) qb = qb.where('sales_orders.created_by', req.user.sub);
        if (req.isCustomerUser) qb = qb.where('sales_orders.customer_id', req.customerId);

        if (orderStatus && orderStatus !== 'all') {
            qb = qb.where('sales_orders.order_status', orderStatus);
        }
        if (dateFrom) qb = qb.where('sales_orders.order_date', '>=', dateFrom);
        if (dateTo)   qb = qb.where('sales_orders.order_date', '<=', dateTo);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('sales_orders.order_no', 'ilike', like)
                 .orWhere('customers.name', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('sales_orders.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('sales_orders.id', 'desc')
            .select(...LIST_COLUMNS);

        // Shape matches QuotationController.list's payload: `data` is the
        // plain rows array, `meta` carries pagination — this is what the
        // shared web `apiList()` helper (web/routes/web.js) expects from
        // every list endpoint.
        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
    } catch (err) {
        console.error('salesOrders.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = baseQuery()
            .where('sales_orders.company_id', req.companyId)
            .whereNull('sales_orders.deleted_at')
            .where('sales_orders.id', id);
        if (req.locationId != null) q.where('sales_orders.location_id', req.locationId);
        if (req.isSalesman) q.where('sales_orders.created_by', req.user.sub);
        if (req.isCustomerUser) q.where('sales_orders.customer_id', req.customerId);
        const order = await q.select(...LIST_COLUMNS).first();
        if (!order) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const items = await db('sales_order_items')
            .where('company_id', req.companyId)
            .where('sales_order_id', id)
            .orderBy('id', 'asc')
            .select('*');

        return R.successResponse(res, { ...order, items });
    } catch (err) {
        console.error('salesOrders.get error:', err);
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
                const cntRow = await trx('sales_orders')
                    .where('company_id', req.companyId)
                    .count('id as c')
                    .first();
                const seq = Number(cntRow ? cntRow.c : 0) + 1;
                const year = new Date(body.order_date || Date.now()).getFullYear();
                orderNo = `SO-${year}-${String(seq).padStart(4, '0')}`;
            }

            const header = {
                company_id:      req.companyId,
                location_id:     effectiveLocationId,
                customer_id:     body.customer_id,
                sales_person_id: (req.isSalesman && req.salesPersonId) ? req.salesPersonId : (body.sales_person_id || null),
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

            const [orderRow] = await trx('sales_orders').insert(header).returning('*');

            const rows = itemRows.map((it) => ({
                company_id:     req.companyId,
                sales_order_id: orderRow.id,
                ...it,
            }));
            const insertedItems = rows.length
                ? await trx('sales_order_items').insert(rows).returning('*') : [];

            return { ...orderRow, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'sales_orders',
            record_type: 'sales_order',
            record_id:   created ? created.id : null,
            action:      'created',
            source:      'cloud',
            before:      null,
            after:       created,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, created, 'Sales order created.');
    } catch (err) {
        // A custom order_no colliding with another LIVE order for this
        // company trips sales_orders_company_no_live_uq (partial unique
        // index — see 20260805180000_sales_orders.js). Surface that as a
        // readable 422 instead of the generic 500 fallback.
        if (err && err.code === '23505' && /sales_orders_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Order No "${(req.body.order_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
        console.error('salesOrders.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function updateDraft(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    const body = req.body;
    try {
        const q = db('sales_orders')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (existing.converted_invoice_id) {
            return R.errorResponse(res, 'This sales order is already converted and can no longer be edited.', 409);
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
                order_date:      body.order_date || existing.order_date,
                due_on:          body.due_on != null ? body.due_on : existing.due_on,
                ledger_name:     body.ledger_name != null ? body.ledger_name : existing.ledger_name,
                subtotal: totals.subtotal, discount: totals.discount, taxable: totals.taxable,
                cgst, sgst, igst,
                tax_amount: totals.tax_amount, round_off: 0, total: totals.total,
                notes: body.notes != null ? body.notes : existing.notes,
                updated_at: now,
            };
            await trx('sales_orders').where({ id, company_id: req.companyId }).update(header);
            await trx('sales_order_items').where({ sales_order_id: id, company_id: req.companyId }).del();
            const rows = itemRows.map((it) => ({ company_id: req.companyId, sales_order_id: id, ...it }));
            const insertedItems = rows.length
                ? await trx('sales_order_items').insert(rows).returning('*') : [];
            const hdr = await trx('sales_orders').where({ id, company_id: req.companyId }).first();
            return { ...hdr, items: insertedItems };
        });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'sales_orders',
            record_type: 'sales_order',
            record_id:   id,
            action:      'updated',
            source:      'cloud',
            before:      existing,
            after:       updated,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, updated, 'Sales order updated.');
    } catch (err) {
        console.error('salesOrders.updateDraft error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function destroy(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        const q = db('sales_orders')
            .where('company_id', req.companyId)
            .whereNull('deleted_at')
            .where('id', id);
        if (req.locationId != null) q.where('location_id', req.locationId);
        if (req.isSalesman) q.where('created_by', req.user.sub);
        const existing = await q.first();
        if (!existing) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const now = new Date();
        await db('sales_orders').where('id', id).update({ deleted_at: now, updated_at: now });

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'sales_orders',
            record_type: 'sales_order',
            record_id:   id,
            action:      'deleted',
            source:      'cloud',
            before:      existing,
            after:       null,
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { id }, 'Sales order deleted.');
    } catch (err) {
        console.error('salesOrders.destroy error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /sales-orders/:id/pdf
 *
 * Renders a clean, data-only sales order PDF. Reuses get()'s rich detail by
 * calling it with a capturing fake-res, then feeds the result through the
 * shared sales-order renderer + Puppeteer (same pipeline as the invoice/
 * quotation PDF).
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
        const { html, landscape } = salesOrderPdfHtml(o, {
            companyName: (company && company.name) || 'Company',
            generatedAt: new Date().toLocaleString('en-IN', { hour12: true }),
        });
        const buf = await htmlToPdf(html, { landscape });
        const fname = String(o.order_no || o.id).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="sales-order-${fname}.pdf"`);
        return res.send(buf);
    } catch (err) {
        console.error('SalesOrderController.pdf error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/* POST /sales-orders/:id/convert — sales order से Sales Invoice बनाता है।
 * एक ही transaction में: invoice + invoice_items बनाओ, order को delivered
 * करो। पहले से converted order पर 409 — दोबारा invoice नहीं बनेगा।
 *
 * Concurrency: the "is it already converted?" check and the write that
 * claims the order both happen INSIDE the same transaction, as a
 * conditional UPDATE (`WHERE id=? AND company_id=? AND
 * converted_invoice_id IS NULL`) that runs AFTER the invoice +
 * invoice_items are inserted but BEFORE the transaction commits. If that
 * update affects 0 rows, another request won the race — we throw to roll
 * the whole transaction back (undoing the invoice/invoice_items insert too,
 * so the loser creates NO invoice at all) and report 409. */
const ALREADY_CONVERTED = Symbol('sales-order-already-converted');

async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        // Same scoping rules as get(): location + salesman (+ customer-portal)
        // restriction, so a user who cannot even view this order cannot
        // convert it either.
        const qq = baseQuery()
            .where('sales_orders.company_id', req.companyId)
            .whereNull('sales_orders.deleted_at')
            .where('sales_orders.id', id);
        if (req.locationId != null) qq.where('sales_orders.location_id', req.locationId);
        if (req.isSalesman) qq.where('sales_orders.created_by', req.user.sub);
        if (req.isCustomerUser) qq.where('sales_orders.customer_id', req.customerId);
        const o = await qq.select('sales_orders.*').first();
        if (!o) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (o.converted_invoice_id) return R.errorResponse(res, 'This sales order is already converted', 409);

        const items = await db('sales_order_items')
            .where({ company_id: req.companyId, sales_order_id: id })
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
            // converted this order. 0 rows affected => a concurrent request
            // won the race; throw to roll back this entire transaction
            // (including the invoice/invoice_items just inserted above) so
            // this request creates NO invoice.
            const claimed = await trx('sales_orders')
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
                return R.errorResponse(res, 'This sales order is already converted', 409);
            }
            throw err;
        }

        await recordHistory(db, {
            company_id:  req.companyId,
            module:      'sales_orders',
            record_type: 'sales_order',
            record_id:   id,
            action:      'converted',
            source:      'cloud',
            before:      o,
            after:       { converted_invoice_id: invoiceRow.id },
            changed_by:  req.user ? req.user.sub : null,
        });

        return R.successResponse(res, { invoice_id: invoiceRow.id }, 'Converted to invoice');
    } catch (err) {
        console.error('salesOrders.convert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, computeTotals };
