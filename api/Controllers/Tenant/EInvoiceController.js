'use strict';

/**
 * api/Controllers/Tenant/EInvoiceController.js
 *
 * e-Invoice (GST IRN) + e-Way Bill on top of sales invoices. GSP-ready:
 *   list      GET  /einvoices                  → sales invoices + their e-invoice status
 *   get       GET  /einvoices/:id              → the e-invoice row for an invoice
 *   generate  POST /einvoices/:id/generate     → build the IRP payload; mint IRN if a
 *                                                 GSP is wired, else mark pending
 *   manual    POST /einvoices/:id/manual       → paste IRN/QR/ack + e-way details
 *   cancel    POST /einvoices/:id/cancel
 *  (:id is the INVOICE id.)
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { buildPayload, gspConfigured } = require('../../Helpers/einvoice');
// Enterprise service layer (provider abstraction + NIC/mock generate + api logs).
const EInvoiceService = require('../../Modules/einvoice/services/EInvoiceService');
const { sendMail } = require('../../Helpers/mail');
const { sendWhatsApp, sendWhatsAppDocument } = require('../../Helpers/whatsapp');
const { renderEinvoicePdf, einvoiceFilename } = require('../../Helpers/einvoicePdf');
const { fullUrl, saveBuffer } = require('../../Helpers/uploads');

// Delivery is via Download / Email / WhatsApp (no browser print), and always as
// the official-format PDF (never the raw JSON). One shared loader pulls the FULL
// company (GSTIN/address) + line items so the PDF matches Tally/NIC exactly.
async function _loadForDelivery(companyId, invoiceId) {
    const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: companyId }).whereNull('deleted_at').first();
    if (!ei) return { error: 'e-Invoice not found.' };
    const inv = await db('invoices').where({ id: invoiceId, company_id: companyId }).first();
    const customer = inv && inv.customer_id ? await db('customers').where('id', inv.customer_id).first() : null;
    const company = await db('companies').where('id', companyId).first();
    const items = await db('invoice_items').where('invoice_id', invoiceId).orderBy('id', 'asc');
    return { ei, inv, customer, company, items };
}

const OOPS = 'Oops..Something went wrong. Please try again.';

async function list(req, res) {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 20));
        const search  = String(req.query.search || '').trim();
        const status  = String(req.query.status || '').trim();     // none|generated|pending|failed|cancelled|eway
        const dateFrom = req.query.date_from;
        const dateTo   = req.query.date_to;

        // Base = sales invoices for this tenant, LEFT-joined to their e-invoice so
        // the count + rows can filter on IRP/EWB status. einvoices.invoice_id is
        // unique, so the join never duplicates an invoice row.
        const base = db('invoices as i')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .leftJoin('einvoices as e', function () { this.on('e.invoice_id', 'i.id').andOnNull('e.deleted_at'); })
            .where('i.company_id', req.companyId).where('i.type', 'sales').whereNull('i.deleted_at');
        if (search) {
            base.where(function () {
                this.where('i.invoice_no', 'ilike', `%${search}%`).orWhere('c.name', 'ilike', `%${search}%`);
            });
        }
        if (dateFrom) base.where('i.invoice_date', '>=', dateFrom);
        if (dateTo)   base.where('i.invoice_date', '<=', dateTo);
        if (status === 'none')            base.whereNull('e.id');
        else if (status === 'generated')  base.where('e.irp_status', 'generated');
        else if (status === 'pending')    base.whereIn('e.irp_status', ['pending', 'generating']);
        else if (status === 'failed')     base.where('e.irp_status', 'failed');
        else if (status === 'cancelled')  base.where('e.irp_status', 'cancelled');
        else if (status === 'eway')       base.whereNotNull('e.ewb_no');

        const [{ count }] = await base.clone().count('i.id as count');
        const total = Number(count) || 0;

        const rows = await base.clone()
            .select('i.id', 'i.invoice_no', 'i.invoice_date', 'i.total',
                'c.name as customer', 'c.gst_number as customer_gstin',
                'e.irn', 'e.ack_no', 'e.ewb_no', 'e.status as einvoice_status',
                'e.irp_status', 'e.ewb_status', 'e.generated_at')
            .orderBy('i.id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, {
            data: rows,
            gsp_configured: gspConfigured(),
            meta: { total, page, per_page: perPage },
        });
    } catch (err) {
        console.error('einvoice.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function get(req, res) {
    try {
        const invoiceId = Number(req.params.id);
        const e = await db('einvoices').where({ invoice_id: invoiceId, company_id: req.companyId }).whereNull('deleted_at').first();
        return R.successResponse(res, e || null);
    } catch (err) {
        console.error('einvoice.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function generate(req, res) {
    try {
        const companyId = req.companyId;
        const invoiceId = Number(req.params.id);
        const inv = await db('invoices').where({ id: invoiceId, company_id: companyId, type: 'sales' }).whereNull('deleted_at').first();
        if (!inv) return R.errorResponse(res, 'Invoice not found.', 404);

        const existing = await db('einvoices').where({ invoice_id: invoiceId }).whereNull('deleted_at').first();
        if (existing && existing.status === 'generated') {
            return R.errorResponse(res, 'This invoice already has an IRN. Cancel it first to regenerate.', 422);
        }

        const items    = await db('invoice_items').where('invoice_id', invoiceId).orderBy('id', 'asc');
        const company  = await db('companies').where('id', companyId).first();
        const customer = inv.customer_id ? await db('customers').where('id', inv.customer_id).first() : null;

        // Build the IRP payload — can throw on incomplete GST data → mark the row
        // 'failed' with a clear message rather than a generic 500.
        let payload = null;
        try {
            payload = buildPayload(inv, items, company, customer);
        } catch (ge) {
            const errMsg = (ge && ge.message) || 'Could not build the IRP payload.';
            const failRow = {
                company_id: companyId, invoice_id: invoiceId, status: 'failed',
                irp_status: 'failed', error: errMsg, payload: null,
                updated_at: new Date(), created_by: req.user ? req.user.sub : null,
            };
            if (existing) await db('einvoices').where('id', existing.id).update(failRow);
            else await db('einvoices').insert(failRow);
            return R.errorResponse(res, 'Could not generate: ' + errMsg, 422);
        }

        // Upsert a 'generating' row FIRST so the api-log + result attach to a real
        // einvoices id (enterprise: every external round-trip is logged per-row).
        const baseRow = {
            company_id: companyId, invoice_id: invoiceId,
            status: 'pending', irp_status: 'generating',
            payload: JSON.stringify(payload),
            updated_at: new Date(), created_by: req.user ? req.user.sub : null,
        };
        let einvoiceId;
        if (existing) {
            await db('einvoices').where('id', existing.id).update(baseRow);
            einvoiceId = existing.id;
        } else {
            const [ins] = await db('einvoices').insert(baseRow).returning('id');
            einvoiceId = ins && ins.id ? ins.id : ins;
        }

        // Resolve the license's provider (NIC; MOCK when no GSP creds) → generate
        // → write masked einvoice_api_logs → persist the normalised fields.
        const licenseId = (company && company.license_id)
            || (req.user && req.user.license_id) || null;
        const svc = await EInvoiceService.generateIrn({
            companyId, licenseId, einvoiceId, payload,
            userId: req.user ? req.user.sub : null,
        });
        await db('einvoices').where('id', einvoiceId).update({ ...svc.fields, updated_at: new Date() });

        const msg = svc.status === 'generated'
            ? 'e-Invoice generated — IRN minted.'
            : ('Could not generate: ' + (svc.fields.error || 'failed'));
        return R.successResponse(res, {
            invoice_id: invoiceId, einvoice_id: einvoiceId, status: svc.status,
            irn: svc.fields.irn || null, payload, gsp_configured: gspConfigured(),
        }, msg);
    } catch (err) {
        console.error('einvoice.generate error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function manual(req, res) {
    try {
        const companyId = req.companyId;
        const invoiceId = Number(req.params.id);
        const inv = await db('invoices').where({ id: invoiceId, company_id: companyId }).whereNull('deleted_at').first('id');
        if (!inv) return R.errorResponse(res, 'Invoice not found.', 404);
        const b = req.body || {};
        const hasKey = !!(b.irn || b.ewb_no);
        const patch = {
            irn: b.irn || null, ack_no: b.ack_no || null, ack_date: b.ack_date || null, qr_code: b.qr_code || null,
            ewb_no: b.ewb_no || null, ewb_date: b.ewb_date || null, ewb_valid_until: b.ewb_valid_until || null,
            transporter: b.transporter || null, transporter_id: b.transporter_id || null, vehicle_no: b.vehicle_no || null,
            distance_km: b.distance_km || null,
            status: hasKey ? 'generated' : 'pending', generated_at: hasKey ? new Date() : null, error: null,
            updated_at: new Date(),
        };
        const existing = await db('einvoices').where({ invoice_id: invoiceId }).whereNull('deleted_at').first('id');
        if (existing) await db('einvoices').where('id', existing.id).update(patch);
        else await db('einvoices').insert({ company_id: companyId, invoice_id: invoiceId, created_by: req.user ? req.user.sub : null, ...patch });
        return R.successResponse(res, { invoice_id: invoiceId }, 'e-Invoice / e-Way details saved.');
    } catch (err) {
        console.error('einvoice.manual error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function companyLicenseId(companyId) {
    const c = await db('companies').where('id', companyId).first('license_id');
    return c ? c.license_id : null;
}

async function cancel(req, res) {
    try {
        const invoiceId = Number(req.params.id);
        const b = req.body || {};
        const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!ei) return R.errorResponse(res, 'e-Invoice not found.', 404);
        // NIC rule: an IRN with an ACTIVE e-Way can't be cancelled — cancel the
        // e-Way first — and IRN cancel is only allowed within 24h of generation.
        if (ei.ewb_no && ei.ewb_status === 'generated') {
            return R.errorResponse(res, 'Cancel the e-Way Bill first — an IRN with an active e-Way cannot be cancelled.', 422);
        }
        if (ei.generated_at && (Date.now() - new Date(ei.generated_at).getTime()) > 24 * 3600e3) {
            return R.errorResponse(res, 'An IRN can only be cancelled within 24 hours of generation.', 422);
        }
        const licenseId = await companyLicenseId(req.companyId);
        const svc = await EInvoiceService.cancelIrn({
            companyId: req.companyId, licenseId, einvoice: ei,
            reasonCode: b.reason_code || b.reason || '2', remarks: b.remarks || '',
            userId: req.user ? req.user.sub : null,
        });
        if (svc.status !== 'cancelled') {
            return R.errorResponse(res, svc.fields.error || 'Could not cancel the IRN.', 422);
        }
        await db('einvoices').where('id', ei.id).update({ ...svc.fields, updated_at: new Date() });
        return R.successResponse(res, { invoice_id: invoiceId }, 'e-Invoice cancelled.');
    } catch (err) {
        console.error('einvoice.cancel error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function generateEway(req, res) {
    try {
        const invoiceId = Number(req.params.id);
        const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!ei) return R.errorResponse(res, 'Generate the IRN first.', 422);
        if (ei.irp_status !== 'generated' && ei.status !== 'generated') {
            return R.errorResponse(res, 'The e-Invoice (IRN) must be generated before the e-Way Bill.', 422);
        }
        if (ei.ewb_no && ei.ewb_status === 'generated') {
            return R.errorResponse(res, 'An e-Way Bill already exists for this invoice.', 422);
        }
        const b = req.body || {};
        const licenseId = await companyLicenseId(req.companyId);
        const svc = await EInvoiceService.generateEway({
            companyId: req.companyId, licenseId, einvoice: ei,
            transport: {
                vehicle_no: b.vehicle_no, transporter: b.transporter, transporter_id: b.transporter_id,
                transport_mode: b.transport_mode, vehicle_type: b.vehicle_type, distance: b.distance,
            },
            userId: req.user ? req.user.sub : null,
        });
        await db('einvoices').where('id', ei.id).update({ ...svc.fields, updated_at: new Date() });
        const msg = svc.status === 'generated'
            ? 'e-Way Bill generated.'
            : ('Could not generate e-Way: ' + (svc.fields.error || 'failed'));
        return R.successResponse(res, { invoice_id: invoiceId, ewb_no: svc.fields.ewb_no || null, status: svc.status }, msg);
    } catch (err) {
        console.error('einvoice.generateEway error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function updateVehicle(req, res) {
    try {
        const invoiceId = Number(req.params.id);
        const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!ei || !ei.ewb_no) return R.errorResponse(res, 'No active e-Way Bill for this invoice.', 422);
        const b = req.body || {};
        if (!b.vehicle_no) return R.errorResponse(res, 'Vehicle number is required.', 422);
        const licenseId = await companyLicenseId(req.companyId);
        const svc = await EInvoiceService.updateVehicle({
            companyId: req.companyId, licenseId, einvoice: ei,
            vehicleNo: b.vehicle_no, transportMode: b.transport_mode,
            reasonCode: b.reason_code, remarks: b.remarks,
            userId: req.user ? req.user.sub : null,
        });
        if (svc.status !== 'ok') return R.errorResponse(res, svc.error || 'Could not update the vehicle.', 422);
        await db('einvoices').where('id', ei.id).update({ ...svc.fields, updated_at: new Date() });
        return R.successResponse(res, { invoice_id: invoiceId }, 'Vehicle updated.');
    } catch (err) {
        console.error('einvoice.updateVehicle error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function extendValidity(req, res) {
    try {
        const invoiceId = Number(req.params.id);
        const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!ei || !ei.ewb_no) return R.errorResponse(res, 'No active e-Way Bill for this invoice.', 422);
        const b = req.body || {};
        const licenseId = await companyLicenseId(req.companyId);
        const svc = await EInvoiceService.extendValidity({
            companyId: req.companyId, licenseId, einvoice: ei,
            distance: b.distance, reasonCode: b.reason_code, remarks: b.remarks, vehicleNo: b.vehicle_no,
            userId: req.user ? req.user.sub : null,
        });
        if (svc.status !== 'ok') return R.errorResponse(res, svc.error || 'Could not extend validity.', 422);
        await db('einvoices').where('id', ei.id).update({ ...svc.fields, updated_at: new Date() });
        return R.successResponse(res, { invoice_id: invoiceId }, 'e-Way validity extended.');
    } catch (err) {
        console.error('einvoice.extendValidity error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function dashboard(req, res) {
    try {
        const cid = req.companyId;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const [genRow, failRow, cancRow, pendRow, expRow, recent, logAgg] = await Promise.all([
            db('einvoices').where('company_id', cid).whereNull('deleted_at').where('irp_status', 'generated').where('generated_at', '>=', today).count('id as c').first(),
            db('einvoices').where('company_id', cid).whereNull('deleted_at').where('irp_status', 'failed').where('updated_at', '>=', today).count('id as c').first(),
            db('einvoices').where('company_id', cid).whereNull('deleted_at').where('irp_status', 'cancelled').where('cancelled_at', '>=', today).count('id as c').first(),
            db('einvoices').where('company_id', cid).whereNull('deleted_at').whereIn('irp_status', ['pending', 'generating']).count('id as c').first(),
            db('einvoices').where('company_id', cid).whereNull('deleted_at').where('ewb_status', 'generated').whereRaw('ewb_valid_until::date = current_date').count('id as c').first(),
            db('einvoices as e').leftJoin('invoices as i', 'i.id', 'e.invoice_id')
                .where('e.company_id', cid).whereNull('e.deleted_at')
                .orderBy('e.updated_at', 'desc').limit(8)
                .select('e.id', 'e.irn', 'e.ewb_no', 'e.irp_status', 'e.ewb_status', 'e.updated_at', 'i.invoice_no'),
            db('einvoice_api_logs').where('company_id', cid).where('created_at', '>=', today)
                .select(db.raw('count(*) filter (where success) as ok'), db.raw('count(*) filter (where not success) as fail')).first(),
        ]);
        const num = (r, k = 'c') => Number(r && r[k]) || 0;
        return R.successResponse(res, {
            today: { generated: num(genRow), failed: num(failRow), cancelled: num(cancRow) },
            pending: num(pendRow),
            expiry_today: num(expRow),
            api_status: { ok: num(logAgg, 'ok'), fail: num(logAgg, 'fail') },
            recent: recent.map((r) => ({
                id: r.id, invoice_no: r.invoice_no, irn: r.irn, ewb_no: r.ewb_no,
                irp_status: r.irp_status, ewb_status: r.ewb_status, at: r.updated_at,
            })),
        });
    } catch (err) {
        console.error('einvoice.dashboard error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function report(req, res) {
    try {
        const cid = req.companyId;
        const type = String(req.query.type || 'irn').toLowerCase();
        const from = req.query.from, to = req.query.to;

        if (type === 'transport') {
            let q = db('einvoice_transport_history as h')
                .leftJoin('einvoices as e', 'e.id', 'h.einvoice_id')
                .leftJoin('invoices as i', 'i.id', 'e.invoice_id')
                .where('h.company_id', cid);
            if (from) q = q.where('h.created_at', '>=', from);
            if (to) q = q.where('h.created_at', '<=', to + ' 23:59:59');
            const rows = await q.orderBy('h.id', 'desc').limit(1000)
                .select('h.id', 'i.invoice_no', 'h.ewb_no', 'h.vehicle_no', 'h.transport_mode', 'h.reason_code', 'h.remarks', 'h.created_at');
            return R.successResponse(res, { type, data: rows });
        }

        let q = db('einvoices as e').leftJoin('invoices as i', 'i.id', 'e.invoice_id')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .where('e.company_id', cid).whereNull('e.deleted_at');
        if (from) q = q.where('e.updated_at', '>=', from);
        if (to) q = q.where('e.updated_at', '<=', to + ' 23:59:59');
        if (type === 'irn') q = q.whereNotNull('e.irn').where('e.irp_status', 'generated');
        else if (type === 'ewb') q = q.whereNotNull('e.ewb_no');
        else if (type === 'cancellation') q = q.where('e.irp_status', 'cancelled');
        else if (type === 'expiry') q = q.whereNotNull('e.ewb_valid_until').whereRaw("e.ewb_valid_until <= now() + interval '2 days'");

        const rows = await q.orderBy('e.updated_at', 'desc').limit(1000).select(
            'e.id', 'i.invoice_no', 'c.name as customer', 'e.gstin', 'e.irn', 'e.ack_no', 'e.ack_date',
            'e.ewb_no', 'e.ewb_valid_until', 'e.irp_status', 'e.ewb_status', 'e.vehicle_no', 'e.updated_at', 'i.total');
        return R.successResponse(res, { type, data: rows });
    } catch (err) {
        console.error('einvoice.report error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function details(req, res) {
    try {
        const cid = req.companyId;
        const invoiceId = Number(req.params.id);
        const ei = await db('einvoices').where({ invoice_id: invoiceId, company_id: cid }).whereNull('deleted_at').first();
        if (!ei) return R.errorResponse(res, 'e-Invoice not found. Generate it first.', 404);
        const inv = await db('invoices').where({ id: invoiceId, company_id: cid }).first();
        const customer = inv && inv.customer_id
            ? await db('customers').where('id', inv.customer_id).first() : null;
        const items = await db('invoice_items').where('invoice_id', invoiceId).orderBy('id', 'asc');
        const [apiLogs, transport, cancellations, validity] = await Promise.all([
            db('einvoice_api_logs').where({ company_id: cid, einvoice_id: ei.id }).orderBy('id', 'desc').limit(30),
            db('einvoice_transport_history').where({ company_id: cid, einvoice_id: ei.id }).orderBy('id', 'desc'),
            db('einvoice_cancellation_history').where({ company_id: cid, einvoice_id: ei.id }).orderBy('id', 'desc'),
            db('einvoice_validity_history').where({ company_id: cid, einvoice_id: ei.id }).orderBy('id', 'desc'),
        ]);
        // Never leak the raw signed payloads / secrets to the detail view.
        delete ei.signed_invoice;
        return R.successResponse(res, {
            einvoice: ei, invoice: inv, customer, items,
            api_logs: apiLogs, transport, cancellations, validity,
        });
    } catch (err) {
        console.error('einvoice.details error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** Bulk-generate IRN for many invoices at once (returns per-id outcome). */
async function bulkGenerate(req, res) {
    try {
        const cid = req.companyId;
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
        if (!ids.length) return R.errorResponse(res, 'Select at least one invoice.', 422);
        const results = [];
        for (const invoiceId of ids.slice(0, 100)) {
            try {
                const inv = await db('invoices').where({ id: invoiceId, company_id: cid, type: 'sales' }).whereNull('deleted_at').first();
                if (!inv) { results.push({ id: invoiceId, status: 'failed', error: 'not found' }); continue; }
                const existing = await db('einvoices').where({ invoice_id: invoiceId }).whereNull('deleted_at').first();
                if (existing && existing.irp_status === 'generated') { results.push({ id: invoiceId, status: 'skipped', error: 'already generated' }); continue; }
                const items = await db('invoice_items').where('invoice_id', invoiceId).orderBy('id', 'asc');
                const company = await db('companies').where('id', cid).first();
                const customer = inv.customer_id ? await db('customers').where('id', inv.customer_id).first() : null;
                let payload;
                try { payload = buildPayload(inv, items, company, customer); }
                catch (ge) { results.push({ id: invoiceId, status: 'failed', error: (ge && ge.message) || 'payload' }); continue; }
                const base = { company_id: cid, invoice_id: invoiceId, status: 'pending', irp_status: 'generating', payload: JSON.stringify(payload), updated_at: new Date(), created_by: req.user ? req.user.sub : null };
                let eid;
                if (existing) { await db('einvoices').where('id', existing.id).update(base); eid = existing.id; }
                else { const [ins] = await db('einvoices').insert(base).returning('id'); eid = ins && ins.id ? ins.id : ins; }
                const svc = await EInvoiceService.generateIrn({ companyId: cid, licenseId: company && company.license_id, einvoiceId: eid, payload, userId: req.user ? req.user.sub : null });
                await db('einvoices').where('id', eid).update({ ...svc.fields, updated_at: new Date() });
                results.push({ id: invoiceId, status: svc.status, irn: svc.fields.irn || null, error: svc.fields.error || null });
            } catch (e) {
                results.push({ id: invoiceId, status: 'failed', error: (e && e.message) || 'error' });
            }
        }
        const ok = results.filter((r) => r.status === 'generated').length;
        return R.successResponse(res, { total: ids.length, generated: ok, results }, `${ok}/${ids.length} generated.`);
    } catch (err) {
        console.error('einvoice.bulkGenerate error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** GET /einvoices/:id/download — the e-Invoice/e-Way Bill as an official-format
 *  PDF (Content-Type: application/pdf). Web streams it to the browser; the app
 *  saves/opens the same bytes — identical document everywhere. */
async function download(req, res) {
    try {
        const cid = req.companyId;
        const invoiceId = Number(req.params.id);
        const { error, ei, inv, customer, company, items } = await _loadForDelivery(cid, invoiceId);
        if (error) return R.errorResponse(res, error, 404);
        const pdf = await renderEinvoicePdf({ ei, inv, items, company, customer });
        await db('einvoice_print_logs').insert({ company_id: cid, einvoice_id: ei.id, doc_type: 'einvoice', channel: 'download', created_by: req.user ? req.user.sub : null }).catch(() => {});
        const fname = einvoiceFilename(ei, inv);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.setHeader('Content-Length', pdf.length);
        return res.status(200).end(pdf);
    } catch (err) {
        console.error('einvoice.download error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** POST /einvoices/:id/email — email the e-invoice details to the customer. */
async function email(req, res) {
    try {
        const cid = req.companyId;
        const invoiceId = Number(req.params.id);
        const { error, ei, inv, customer, company, items } = await _loadForDelivery(cid, invoiceId);
        if (error) return R.errorResponse(res, error, 404);
        if (!ei.irn) return R.errorResponse(res, 'Generate the IRN before sending.', 422);
        const to = (req.body && String(req.body.email || '').trim()) || (customer && customer.email);
        if (!to) return R.errorResponse(res, 'No customer email on file — add one or enter it.', 422);
        const coName = company ? (company.mailing_name || company.name) : '';
        const isEway = !!ei.ewb_no;
        const docWord = isEway && ei.irn ? 'e-Invoice & e-Way Bill' : (isEway ? 'e-Way Bill' : 'e-Invoice');
        const subject = `${docWord} ${inv.invoice_no} — ${coName}`;
        // Short cover note; the official-format PDF is attached below.
        const html = `<p>Dear ${customer ? customer.name : 'Customer'},</p>`
            + `<p>Please find your GST ${docWord} attached as a PDF.</p>`
            + `<table cellpadding="4" style="border-collapse:collapse">`
            + `<tr><td><b>Invoice</b></td><td>${inv.invoice_no}</td></tr>`
            + (ei.irn ? `<tr><td><b>IRN</b></td><td style="word-break:break-all">${ei.irn}</td></tr>` : '')
            + (ei.ewb_no ? `<tr><td><b>e-Way Bill</b></td><td>${ei.ewb_no} (valid till ${ei.ewb_valid_until ? new Date(ei.ewb_valid_until).toLocaleDateString('en-IN') : '—'})</td></tr>` : '')
            + `<tr><td><b>Amount</b></td><td>₹${Number(inv.total).toLocaleString('en-IN')}</td></tr>`
            + `</table><p>Regards,<br>${coName}</p>`;
        // Render the official-format PDF and attach it.
        const pdf = await renderEinvoicePdf({ ei, inv, items, company, customer });
        const fname = einvoiceFilename(ei, inv);
        await sendMail({
            to, subject, html,
            text: `${docWord} ${inv.invoice_no}${ei.irn ? ' · IRN ' + ei.irn : ''} · ₹${Number(inv.total).toLocaleString('en-IN')} (PDF attached)`,
            attachments: [{ filename: fname, content: pdf, contentType: 'application/pdf' }],
        });
        await db('einvoice_print_logs').insert({ company_id: cid, einvoice_id: ei.id, doc_type: 'einvoice', channel: 'email', created_by: req.user ? req.user.sub : null }).catch(() => {});
        return R.successResponse(res, { to }, `${docWord} PDF emailed to ${to}.`);
    } catch (err) {
        console.error('einvoice.email error:', err);
        return R.errorResponse(res, 'Could not send the email — check the SMTP/MAIL settings.', 500);
    }
}

/** POST /einvoices/:id/whatsapp — send the official-format PDF to the customer on
 *  WhatsApp as a DOCUMENT. The PDF is published under /uploads so WhatsApp Cloud
 *  API can fetch it by link; a short text caption rides along. */
async function whatsapp(req, res) {
    try {
        const cid = req.companyId;
        const invoiceId = Number(req.params.id);
        const { error, ei, inv, customer, company, items } = await _loadForDelivery(cid, invoiceId);
        if (error) return R.errorResponse(res, error, 404);
        if (!ei.irn) return R.errorResponse(res, 'Generate the IRN before sending.', 422);
        const to = (req.body && String(req.body.mobile || '').trim()) || (customer && customer.mobile);
        if (!to) return R.errorResponse(res, 'No customer mobile on file — add one or enter it.', 422);
        const coName = company ? (company.mailing_name || company.name) : '';
        const isEway = !!ei.ewb_no;
        const docWord = isEway && ei.irn ? 'e-Invoice & e-Way Bill' : (isEway ? 'e-Way Bill' : 'e-Invoice');

        // Render + publish the PDF so WhatsApp can fetch it by public link.
        const pdf = await renderEinvoicePdf({ ei, inv, items, company, customer });
        const fname = einvoiceFilename(ei, inv);
        const rel = saveBuffer(`einvoices/${cid}/${fname}`, pdf);
        const link = fullUrl(req, rel);

        const caption = `*${docWord} ${inv.invoice_no}*\n${coName}`
            + (ei.irn ? `\nIRN: ${ei.irn}` : '')
            + (ei.ewb_no ? `\ne-Way: ${ei.ewb_no}` : '')
            + `\nAmount: ₹${Number(inv.total).toLocaleString('en-IN')}`;
        await sendWhatsAppDocument(to, link, fname, caption);
        await db('einvoice_print_logs').insert({ company_id: cid, einvoice_id: ei.id, doc_type: 'einvoice', channel: 'whatsapp', created_by: req.user ? req.user.sub : null }).catch(() => {});
        return R.successResponse(res, { to }, `${docWord} PDF sent on WhatsApp to ${to}.`);
    } catch (err) {
        console.error('einvoice.whatsapp error:', err);
        return R.errorResponse(res, 'Could not send on WhatsApp — check the integration.', 500);
    }
}

module.exports = { list, get, generate, manual, cancel, generateEway, updateVehicle, extendValidity, dashboard, report, details, bulkGenerate, download, email, whatsapp };
