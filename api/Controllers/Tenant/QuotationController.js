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
const { nextVoucherNo } = require('../../Helpers/voucherNumber');

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
        const { page, perPage } = parsePagination(req.query);
        const search   = (req.query.search || '').trim();
        // `quote_status` is the QUOTATION-SPECIFIC deal-lifecycle filter
        // (open/accepted/rejected/expired) — it targets `quotations.quote_status`.
        // It is intentionally NOT named `status`: `status` is reserved app-wide
        // for the Tally-sync lifecycle (see InvoiceController / listInvoiceSchema
        // `status`), which `quotations.status` also tracks independently of the
        // deal outcome. Using `status` here would silently collide with that.
        const quoteStatus = (req.query.quote_status || '').trim();
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;
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
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('quotations.id', 'desc')
            .select(...LIST_COLUMNS);

        const todayIso = new Date().toISOString().slice(0, 10);
        rows = rows.map((r) => withDerivedStatus(r, todayIso));
        // ?quote_status=expired is a DERIVED filter — apply it after deriving.
        if (quoteStatus === 'expired') rows = rows.filter((r) => r.quote_status === 'expired');

        // Shape matches InvoiceController.listByType's payload: `data` is the
        // plain rows array, `meta` carries pagination — this is what the shared
        // web `apiList()` helper (web/routes/web.js) expects from every list
        // endpoint. Quotations have no register "grand total" concept, so meta
        // omits `grand_total` (invoice-only).
        const payload = { data: rows, meta: { total, page, per_page: perPage } };
        return R.successResponse(res, payload);
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
                // Re-derived HERE, inside the transaction, even though the form
                // already showed a number: what the form showed was a preview
                // taken before anyone else had saved.
                quotationNo = await nextVoucherNo(trx, {
                    companyId: req.companyId,
                    table: 'quotations',
                    column: 'quotation_no',
                    date: body.quotation_date,
                });
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
                // Buyer / consignee / dispatch / order block — see the
                // voucher_print_details migration. Stored as a whole, so an
                // absent body leaves an empty object rather than null (the
                // column is NOT NULL and the readers expect an object).
                voucher_details: JSON.stringify(body.voucher_details || {}),
                created_by:      req.user && req.user.sub ? req.user.sub : null,
                // Ready to sync as soon as it's saved — the DB default is
                // 'draft_cloud' (pre-push), so this row must say explicitly
                // it is waiting for the agent to pick it up. (Task 2.)
                status:          'pending_tally',
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
        // A custom quotation_no colliding with another LIVE quotation for this
        // company trips quotations_company_no_live_uq (partial unique index —
        // see 20260805120000_quotations_indexes_and_partial_unique.js). Surface
        // that as a readable 422 instead of the generic 500 fallback.
        if (err && err.code === '23505' && /quotations_company_no_live_uq/.test(err.constraint || err.message || '')) {
            return R.errorResponse(res, `Quotation No "${(req.body.quotation_no || '').trim()}" is already in use. Please choose a different number.`, 422);
        }
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
                // Only replaced when the client actually sent a block, so a
                // partial update cannot silently wipe the dispatch details.
                ...(body.voucher_details != null
                    ? { voucher_details: JSON.stringify(body.voucher_details) } : {}),
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
 * करो। पहले से converted quotation पर 409 — दोबारा invoice नहीं बनेगा।
 *
 * Concurrency: the "is it already converted?" check and the write that claims
 * the quotation both happen INSIDE the same transaction, as a conditional
 * UPDATE (`WHERE id=? AND company_id=? AND converted_invoice_id IS NULL`)
 * that runs AFTER the invoice + invoice_items are inserted but BEFORE the
 * transaction commits. If that update affects 0 rows, another request won
 * the race — we throw to roll the whole transaction back (undoing the
 * invoice/invoice_items insert too, so the loser creates NO invoice at all)
 * and report 409. */
const ALREADY_CONVERTED = Symbol('quotation-already-converted');

async function convert(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND_MSG, 404);
    try {
        // Same scoping rules as get(): location + salesman (+ customer-portal)
        // restriction, so a user who cannot even view this quotation cannot
        // convert it either.
        const qq = baseQuery()
            .where('quotations.company_id', req.companyId)
            .whereNull('quotations.deleted_at')
            .where('quotations.id', id);
        if (req.locationId != null) qq.where('quotations.location_id', req.locationId);
        if (req.isSalesman) qq.where('quotations.created_by', req.user.sub);
        if (req.isCustomerUser) qq.where('quotations.customer_id', req.customerId);
        const q = await qq.select('quotations.*').first();
        if (!q) return R.errorResponse(res, NOT_FOUND_MSG, 404);
        if (q.converted_invoice_id) return R.errorResponse(res, 'This quotation is already converted', 409);

        const items = await db('quotation_items')
            .where({ company_id: req.companyId, quotation_id: id })
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
            // Atomic claim: only succeeds if no other request already
            // converted this quotation. 0 rows affected => a concurrent
            // request won the race; throw to roll back this entire
            // transaction (including the invoice/invoice_items just
            // inserted above) so this request creates NO invoice.
            const claimed = await trx('quotations')
                .where({ id, company_id: req.companyId })
                .whereNull('converted_invoice_id')
                .update({
                    quote_status:         'accepted',
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
                return R.errorResponse(res, 'This quotation is already converted', 409);
            }
            throw err;
        }

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

/**
 * GET /quotations/next-no?date=YYYY-MM-DD — the number this quotation would
 * get if saved now, so the create form can SHOW it instead of the vague
 * "Auto-generated on save". A preview, not a reservation — see
 * Helpers/voucherNumber; create() derives it again inside its transaction.
 */
async function nextNo(req, res) {
    try {
        const quotationNo = await nextVoucherNo(db, {
            companyId: req.companyId,
            table: 'quotations',
            column: 'quotation_no',
            date: req.query.date,
        });
        return R.successResponse(res, { quotation_no: quotationNo });
    } catch (err) {
        console.error('quotations.nextNo error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, get, create, updateDraft, destroy, pdf, convert, nextNo, computeTotals };
