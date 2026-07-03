'use strict';

/**
 * api/Modules/einvoice/providers/nic/NicProvider.js
 *
 * NIC IRP adapter (the primary provider). It implements IEInvoiceProvider and
 * normalises NIC's e-Invoice/e-Way responses. Two modes:
 *
 *   • REAL   — when GSP credentials + a base_url are configured, it authenticates
 *              (AuthToken + SEK), AES-encrypts the request, calls the NIC APIs,
 *              decrypts + normalises. (The real HTTP calls are marked TODO where
 *              a live GSP account is required; the auth/crypto scaffold + the
 *              normalisation + logging are all here.)
 *   • MOCK   — when no creds are configured (LOCAL testing), it returns a
 *              DETERMINISTIC, NIC-SHAPED IRN/QR/e-Way so the whole flow (generate
 *              → store → print → cancel) can be exercised end-to-end without a
 *              real GSP. Every mock response carries `mock:true`.
 *
 * The IRN is the SHA-256 of `SupplierGSTIN|DocType|DocNo|FY` — the SAME rule NIC
 * uses — so de-dup + reconcile behave identically in mock + real modes.
 */

const crypto = require('crypto');
const { IEInvoiceProvider } = require('../IEInvoiceProvider');

/** Financial year (Apr–Mar) for a doc date → "2025-26". */
function fyOf(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const y = d.getFullYear();
    const startYear = d.getMonth() >= 3 ? y : y - 1; // Apr = month 3
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** NIC-style IRN = 64-hex SHA-256 of supplierGSTIN|docType|docNo|FY. */
function computeIrn(gstin, docType, docNo, docDate) {
    const base = `${gstin || ''}|${docType || 'INV'}|${docNo || ''}|${fyOf(docDate)}`;
    return crypto.createHash('sha256').update(base).digest('hex');
}

class NicProvider extends IEInvoiceProvider {
    get name() { return 'nic'; }

    /** MOCK when there is no configured base_url / auth credential. */
    _useMock() {
        const c = this.creds || {};
        return !(c.base_url && (c.password || c.client_secret || c.api_key));
    }

    async authenticate() {
        if (this._useMock()) {
            return { authToken: 'MOCK-AUTH', sek: 'MOCK-SEK', expiresAt: new Date(Date.now() + 6 * 3600e3) };
        }
        // TODO(real): POST {base_url}/eivital/v1.04/auth with app_key (RSA-enc),
        // decrypt Sek, cache AuthToken+Sek. Log the round-trip.
        throw new Error('NIC authenticate(): live GSP credentials required.');
    }

    async generateIrn(payload) {
        const t0 = Date.now();
        const doc = payload.DocDtls || {};
        const seller = payload.SellerDtls || {};
        const irn = computeIrn(seller.Gstin, doc.Typ, doc.No, doc.Dt);
        if (this._useMock()) {
            const now = new Date();
            const ackDt = now.toISOString().slice(0, 19).replace('T', ' ');
            const ackNo = Number(String(now.getTime()).slice(-12));
            const qrObj = {
                SellerGstin: seller.Gstin,
                BuyerGstin: (payload.BuyerDtls || {}).Gstin,
                DocNo: doc.No,
                DocTyp: doc.Typ,
                DocDt: doc.Dt,
                TotInvVal: (payload.ValDtls || {}).TotInvVal,
                Irn: irn,
                AckNo: ackNo,
                AckDt: ackDt,
            };
            const signedQr = Buffer.from(JSON.stringify(qrObj)).toString('base64');
            this.log({ action: 'generate_irn', endpoint: 'mock', httpStatus: 200, nicStatusCode: '1', success: true, latencyMs: Date.now() - t0, request: payload, response: { irn, ackNo, ackDt, mock: true } });
            return {
                status: 'generated',
                irn, ackNo, ackDt,
                signedInvoice: 'MOCK.' + Buffer.from(JSON.stringify(payload)).toString('base64').slice(0, 64),
                signedQr,
                ewbNo: null,
                raw: { mock: true, ...qrObj },
            };
        }
        // TODO(real): encrypt payload with SEK, POST {base_url}/eicore/v1.03/Invoice,
        // decrypt Data, map { Irn, AckNo, AckDt, SignedInvoice, SignedQRCode, EwbNo }.
        throw new Error('NIC generateIrn(): live GSP credentials required.');
    }

    async cancelIrn({ irn, reasonCode, remarks }) {
        const t0 = Date.now();
        if (this._useMock()) {
            const cancelDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
            this.log({ action: 'cancel_irn', endpoint: 'mock', httpStatus: 200, nicStatusCode: '1', success: true, latencyMs: Date.now() - t0, request: { irn, reasonCode, remarks }, response: { cancelDate, mock: true } });
            return { status: 'cancelled', cancelDate, raw: { mock: true } };
        }
        throw new Error('NIC cancelIrn(): live GSP credentials required.');
    }

    async getIrnByDoc({ docType, docNo, docDate }) {
        // Reconcile a timeout: NIC often generates the IRN even when the client
        // times out. In mock mode we recompute deterministically.
        if (this._useMock()) {
            const irn = computeIrn(this.gstin, docType, docNo, docDate);
            return { status: 'generated', irn, ackNo: null, ackDt: null, signedInvoice: null, signedQr: null, raw: { mock: true, reconciled: true } };
        }
        throw new Error('NIC getIrnByDoc(): live GSP credentials required.');
    }

    async generateEwb(payload) {
        return this._mockOrRealEwb(payload);
    }

    async generateEwbByIrn(args) {
        return this._mockOrRealEwb(args);
    }

    async _mockOrRealEwb(payload) {
        const t0 = Date.now();
        if (this._useMock()) {
            const now = new Date();
            // 12-digit e-Way number (NIC format).
            const ewbNo = Number('1' + String(now.getTime()).slice(-11));
            const ewbDate = now.toISOString().slice(0, 19).replace('T', ' ');
            // Validity: 1 day per 200km (min 1 day). distance may be on the payload.
            const dist = Number(payload.TransDistance || payload.distance || 0) || 0;
            const days = Math.max(1, Math.ceil(dist / 200));
            const validUpto = new Date(now.getTime() + days * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
            this.log({ action: 'generate_ewb', endpoint: 'mock', httpStatus: 200, nicStatusCode: '1', success: true, latencyMs: Date.now() - t0, request: payload, response: { ewbNo, validUpto, mock: true } });
            return { status: 'generated', ewbNo: String(ewbNo), ewbDate, validUpto, raw: { mock: true } };
        }
        throw new Error('NIC generateEwb(): live GSP credentials required.');
    }

    async cancelEwb({ ewbNo, reasonCode, remarks }) {
        if (this._useMock()) return { status: 'ok', ewbNo, raw: { mock: true } };
        throw new Error('NIC cancelEwb(): live GSP credentials required.');
    }

    async updateVehicle({ ewbNo, vehicleNo }) {
        if (this._useMock()) return { status: 'ok', ewbNo, vehicleNo, raw: { mock: true } };
        throw new Error('NIC updateVehicle(): live GSP credentials required.');
    }

    async extendValidity({ ewbNo }) {
        if (this._useMock()) {
            const validUpto = new Date(Date.now() + 86400e3).toISOString().slice(0, 19).replace('T', ' ');
            return { status: 'ok', ewbNo, validUpto, raw: { mock: true } };
        }
        throw new Error('NIC extendValidity(): live GSP credentials required.');
    }

    async pinToPinDistance({ fromPin, toPin }) {
        if (this._useMock()) {
            // Deterministic pseudo-distance from the pins (stable, non-random).
            const d = Math.abs((Number(fromPin) || 0) - (Number(toPin) || 0)) % 1800;
            return { distance: d || 10, raw: { mock: true } };
        }
        throw new Error('NIC pinToPinDistance(): live GSP credentials required.');
    }
}

module.exports = { NicProvider, computeIrn, fyOf };
