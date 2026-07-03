'use strict';

/**
 * api/Modules/einvoice/providers/IEInvoiceProvider.js
 *
 * The GSP adapter CONTRACT. Every provider (NIC, ClearTax, Masters India, Vayana,
 * Adequare, Avalara) subclasses this so EInvoiceService stays provider-agnostic —
 * swap the provider, not the business logic. Each method returns a NORMALISED
 * shape (documented below), NOT the raw GSP payload; every adapter is responsible
 * for mapping its provider's field names + error codes onto these shapes.
 *
 * Normalised results
 * ------------------
 *   generateIrn(payload) ->
 *     { status:'generated'|'duplicate'|'failed', irn, ackNo, ackDt,
 *       signedInvoice, signedQr, ewbNo?, errorCode?, errorMessage?, raw }
 *   cancelIrn(...)        -> { status:'cancelled'|'failed', cancelDate, errorCode?, errorMessage?, raw }
 *   getIrnByDoc(...)      -> same shape as generateIrn (used to RECONCILE a timeout)
 *   generateEwb(...) / generateEwbByIrn(...) ->
 *     { status:'generated'|'failed', ewbNo, ewbDate, validUpto, errorCode?, errorMessage?, raw }
 *   cancelEwb / updateVehicle / extendValidity ->
 *     { status:'ok'|'failed', ...fields, errorCode?, errorMessage?, raw }
 *   pinToPinDistance(...) -> { distance:number|null, raw }
 *
 * The constructor receives resolved, DECRYPTED credentials + env + a logger the
 * adapter calls for EVERY external round-trip (so einvoice_api_logs is complete):
 *   log({ action, endpoint, httpStatus, nicStatusCode, success, latencyMs, request, response, error })
 */
class IEInvoiceProvider {
    constructor(opts = {}) {
        this.creds = opts.creds || {};
        this.env = opts.env || 'sandbox';
        this.gstin = opts.gstin || null;
        this.log = typeof opts.log === 'function' ? opts.log : () => {};
    }

    /** Machine name — matches the `provider` column ('nic', 'cleartax', …). */
    get name() { return 'base'; }

    // eslint-disable-next-line no-unused-vars
    async authenticate(gstin) { throw new Error(`${this.name}.authenticate() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async generateIrn(payload) { throw new Error(`${this.name}.generateIrn() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async cancelIrn(args) { throw new Error(`${this.name}.cancelIrn() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async getIrnByDoc(args) { throw new Error(`${this.name}.getIrnByDoc() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async generateEwb(payload) { throw new Error(`${this.name}.generateEwb() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async generateEwbByIrn(args) { throw new Error(`${this.name}.generateEwbByIrn() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async cancelEwb(args) { throw new Error(`${this.name}.cancelEwb() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async updateVehicle(args) { throw new Error(`${this.name}.updateVehicle() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async extendValidity(args) { throw new Error(`${this.name}.extendValidity() not implemented`); }
    // eslint-disable-next-line no-unused-vars
    async pinToPinDistance(args) { throw new Error(`${this.name}.pinToPinDistance() not implemented`); }
}

module.exports = { IEInvoiceProvider };
