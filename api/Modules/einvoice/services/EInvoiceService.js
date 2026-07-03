'use strict';

/**
 * api/Modules/einvoice/services/EInvoiceService.js
 *
 * Orchestrates IRN generation on top of the provider abstraction. The caller
 * builds the IRP payload (Helpers/einvoice.buildPayload) and passes the einvoices
 * row context; this resolves the license's provider (NIC by default, MOCK when no
 * GSP creds), calls generateIrn, writes a MASKED einvoice_api_logs row for the
 * round-trip, and returns the normalised column values to persist on einvoices
 * (both the legacy `status` + the new `irp_status`/signed/dedup fields).
 *
 * Never throws for a GSP failure — returns a 'failed' result so the controller
 * marks the row failed with a clear message (the row is the source of truth, the
 * job queue can retry it).
 */

const db = require('../../../config/db').db;
const { resolveProvider } = require('../providers/ProviderFactory');
const { fyOf } = require('../providers/nic/NicProvider');

// Keys whose VALUES must never be persisted to the api-log (secrets).
const SECRET_KEYS = /^(password|client_secret|api_key|authtoken|auth_token|sek|token|app_key)$/i;

function mask(value) {
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.test(k) ? '***' : mask(v);
        }
        return out;
    }
    return value;
}

async function flushLogs(companyId, einvoiceId, userId, provider, env, logs) {
    for (const e of logs) {
        try {
            await db('einvoice_api_logs').insert({
                company_id:      companyId,
                einvoice_id:     einvoiceId || null,
                provider:        provider || 'nic',
                env:             env || 'sandbox',
                action:          e.action || 'generate_irn',
                endpoint:        e.endpoint || null,
                http_status:     e.httpStatus || null,
                nic_status_code: e.nicStatusCode != null ? String(e.nicStatusCode) : null,
                success:         !!e.success,
                latency_ms:      e.latencyMs || null,
                request:         e.request ? JSON.stringify(mask(e.request)) : null,
                response:        e.response ? JSON.stringify(mask(e.response)) : null,
                error:           e.error || null,
                created_by:      userId || null,
            });
        } catch (_) { /* logging must never break the generate flow */ }
    }
}

/**
 * Generate an IRN for a built IRP payload.
 * @returns {Promise<{ status:'generated'|'failed', fields:object }>}
 *   `fields` = einvoices columns to persist.
 */
async function generateIrn({ companyId, licenseId, einvoiceId, payload, userId }) {
    const seller = payload.SellerDtls || {};
    const doc = payload.DocDtls || {};
    const gstin = seller.Gstin || null;

    const logs = [];
    let result;
    let providerName = 'nic';
    let env = 'sandbox';
    try {
        const provider = await resolveProvider({
            licenseId, companyId, gstin, log: (e) => logs.push(e),
        });
        providerName = provider.name || 'nic';
        env = provider.env || 'sandbox';
        result = await provider.generateIrn(payload);
    } catch (e) {
        result = { status: 'failed', errorMessage: (e && e.message) || 'GSP call failed.' };
    }

    await flushLogs(companyId, einvoiceId, userId, providerName, env, logs);

    const now = new Date();
    const dedupHash = `${gstin || ''}|${doc.Typ || 'INV'}|${doc.No || ''}|${fyOf(doc.Dt)}`.slice(0, 80);

    if (result && result.status === 'generated') {
        return {
            status: 'generated',
            fields: {
                status:         'generated',        // legacy lifecycle
                irp_status:     'generated',
                irn:            result.irn,
                ack_no:         result.ackNo != null ? String(result.ackNo) : null,
                ack_date:       result.ackDt ? new Date(String(result.ackDt).replace(' ', 'T')) : now,
                qr_code:        result.signedQr || null,
                signed_qr:      result.signedQr || null,
                signed_invoice: result.signedInvoice || null,
                ewb_no:         result.ewbNo || null,
                ewb_status:     result.ewbNo ? 'generated' : 'not_required',
                gstin,
                doc_type:       doc.Typ || 'INV',
                provider:       providerName,
                env,
                dedup_hash:     dedupHash,
                error:          null,
                generated_at:   now,
            },
        };
    }

    return {
        status: 'failed',
        fields: {
            status:     'failed',
            irp_status: 'failed',
            error:      (result && result.errorMessage) || 'Could not generate the IRN.',
            gstin,
            doc_type:   doc.Typ || 'INV',
            provider:   providerName,
            env,
            dedup_hash: dedupHash,
        },
    };
}

/** Generate an e-Way bill (from the IRN when present, else Part-A/B directly). */
async function generateEway({ companyId, licenseId, einvoice, transport, userId }) {
    const logs = [];
    const t = transport || {};
    let result, providerName = 'nic', env = 'sandbox';
    try {
        const provider = await resolveProvider({ licenseId, companyId, gstin: einvoice.gstin, log: (e) => logs.push(e) });
        providerName = provider.name || 'nic'; env = provider.env || 'sandbox';
        const ewbPayload = {
            Irn: einvoice.irn || null,
            TransMode: t.transport_mode || '1',
            TransId: t.transporter_id || null,
            VehNo: t.vehicle_no || null,
            VehType: t.vehicle_type || 'R',
            TransDistance: Number(t.distance) || 0,
            distance: Number(t.distance) || 0,
        };
        result = einvoice.irn
            ? await provider.generateEwbByIrn(ewbPayload)
            : await provider.generateEwb(ewbPayload);
    } catch (e) {
        result = { status: 'failed', errorMessage: (e && e.message) || 'e-Way generation failed.' };
    }
    await flushLogs(companyId, einvoice.id, userId, providerName, env, logs);
    const now = new Date();
    if (result && result.status === 'generated') {
        return {
            status: 'generated',
            fields: {
                ewb_no:          result.ewbNo,
                ewb_date:        result.ewbDate ? new Date(String(result.ewbDate).replace(' ', 'T')) : now,
                ewb_valid_until: result.validUpto ? new Date(String(result.validUpto).replace(' ', 'T')) : null,
                ewb_status:      'generated',
                ewb_part:        t.vehicle_no ? 'AB' : 'A',
                vehicle_no:      t.vehicle_no || null,
                transporter:     t.transporter || null,
                transporter_id:  t.transporter_id || null,
                transport_mode:  t.transport_mode || null,
                vehicle_type:    t.vehicle_type || null,
                distance_km:     Number(t.distance) || null,
                error:           null,
            },
        };
    }
    return { status: 'failed', fields: { ewb_status: 'pending', error: (result && result.errorMessage) || 'e-Way generation failed.' } };
}

/** Cancel the IRN (24h window + no active e-way — enforced by the controller). */
async function cancelIrn({ companyId, licenseId, einvoice, reasonCode, remarks, userId }) {
    const logs = [];
    let result, providerName = 'nic', env = 'sandbox';
    try {
        const provider = await resolveProvider({ licenseId, companyId, gstin: einvoice.gstin, log: (e) => logs.push(e) });
        providerName = provider.name || 'nic'; env = provider.env || 'sandbox';
        result = await provider.cancelIrn({ irn: einvoice.irn, reasonCode: reasonCode || '2', remarks: remarks || '' });
    } catch (e) {
        result = { status: 'failed', errorMessage: (e && e.message) || 'Cancel failed.' };
    }
    await flushLogs(companyId, einvoice.id, userId, providerName, env, logs);
    if (result && result.status === 'cancelled') {
        await db('einvoice_cancellation_history').insert({
            company_id: companyId, einvoice_id: einvoice.id, kind: 'irn',
            doc_ref: einvoice.irn || null, reason_code: reasonCode || '2',
            remarks: remarks || null, created_by: userId || null,
        }).catch(() => {});
        return { status: 'cancelled', fields: { status: 'cancelled', irp_status: 'cancelled', cancelled_at: new Date(), cancel_reason: remarks || null } };
    }
    return { status: 'failed', fields: { error: (result && result.errorMessage) || 'Cancel failed.' } };
}

/** Update the vehicle (Part-B) on an active e-Way. Writes transport history. */
async function updateVehicle({ companyId, licenseId, einvoice, vehicleNo, transportMode, reasonCode, remarks, userId }) {
    const logs = [];
    let result, providerName = 'nic', env = 'sandbox';
    try {
        const provider = await resolveProvider({ licenseId, companyId, gstin: einvoice.gstin, log: (e) => logs.push(e) });
        providerName = provider.name || 'nic'; env = provider.env || 'sandbox';
        result = await provider.updateVehicle({ ewbNo: einvoice.ewb_no, vehicleNo, transMode: transportMode, reasonCode, remarks });
    } catch (e) {
        result = { status: 'failed', errorMessage: (e && e.message) || 'Vehicle update failed.' };
    }
    await flushLogs(companyId, einvoice.id, userId, providerName, env, logs);
    if (result && result.status === 'ok') {
        await db('einvoice_transport_history').insert({
            company_id: companyId, einvoice_id: einvoice.id, ewb_no: einvoice.ewb_no || null,
            vehicle_no: vehicleNo || null, transport_mode: transportMode || null,
            reason_code: reasonCode || null, remarks: remarks || null, created_by: userId || null,
        }).catch(() => {});
        return { status: 'ok', fields: { vehicle_no: vehicleNo || null, ewb_part: 'AB', transport_mode: transportMode || einvoice.transport_mode } };
    }
    return { status: 'failed', error: (result && result.errorMessage) || 'Vehicle update failed.' };
}

/** Extend an e-Way's validity. Writes validity history. */
async function extendValidity({ companyId, licenseId, einvoice, distance, reasonCode, remarks, vehicleNo, userId }) {
    const logs = [];
    let result, providerName = 'nic', env = 'sandbox';
    try {
        const provider = await resolveProvider({ licenseId, companyId, gstin: einvoice.gstin, log: (e) => logs.push(e) });
        providerName = provider.name || 'nic'; env = provider.env || 'sandbox';
        result = await provider.extendValidity({ ewbNo: einvoice.ewb_no, remainingDistance: distance, reasonCode, remarks, vehicleNo });
    } catch (e) {
        result = { status: 'failed', errorMessage: (e && e.message) || 'Extend failed.' };
    }
    await flushLogs(companyId, einvoice.id, userId, providerName, env, logs);
    if (result && result.status === 'ok') {
        const validUpto = result.validUpto ? new Date(String(result.validUpto).replace(' ', 'T')) : null;
        await db('einvoice_validity_history').insert({
            company_id: companyId, einvoice_id: einvoice.id, ewb_no: einvoice.ewb_no || null,
            extended_until: validUpto, remaining_distance: Number(distance) || null,
            reason_code: reasonCode || null, remarks: remarks || null,
            vehicle_no: vehicleNo || null, created_by: userId || null,
        }).catch(() => {});
        return { status: 'ok', fields: { ewb_valid_until: validUpto || einvoice.ewb_valid_until } };
    }
    return { status: 'failed', error: (result && result.errorMessage) || 'Extend failed.' };
}

module.exports = { generateIrn, generateEway, cancelIrn, updateVehicle, extendValidity, mask };
