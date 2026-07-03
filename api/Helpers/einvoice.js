'use strict';

/**
 * api/Helpers/einvoice.js
 *
 * Build the GST e-invoice (IRP schema 1.1) payload from an invoice + its lines +
 * the company / customer GST details — the exact JSON a GSP (ClearTax / Masters
 * India / NIC IRP) needs to mint an IRN. A GSP call is stubbed: when the
 * EINVOICE_GSP_URL / EINVOICE_GSP_KEY env vars are set, `callGsp` POSTs the
 * payload; otherwise it returns null so the tenant records the IRN/QR manually
 * (pasted from the GST portal). GSP-ready.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** GST state code = first two digits of the GSTIN. */
function stateCode(gstin) {
    return gstin && String(gstin).length >= 2 ? String(gstin).slice(0, 2) : '';
}

function fmtDate(d) {
    if (!d) return '';
    const x = new Date(d);
    return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}

/** Build the IRP e-invoice payload. Intra-state → CGST+SGST, inter-state → IGST. */
function buildPayload(invoice, items, company, customer) {
    const sellerSt = stateCode(company && company.gst_number) || '';
    const buyerGstin = (customer && customer.gst_number) || '';
    const buyerSt = buyerGstin ? stateCode(buyerGstin) : sellerSt;
    const intra = buyerSt === sellerSt;

    return {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: 'INV', No: invoice.invoice_no, Dt: fmtDate(invoice.invoice_date) },
        SellerDtls: {
            Gstin: (company && company.gst_number) || '',
            LglNm: (company && (company.mailing_name || company.name)) || '',
            Addr1: ((company && company.address) || 'NA').slice(0, 100),
            Loc:   ((company && company.address) || 'NA').slice(0, 50),
            Pin:   Number(company && company.pincode) || 0,
            Stcd:  sellerSt,
        },
        BuyerDtls: {
            Gstin: buyerGstin || 'URP',
            LglNm: (customer && customer.name) || 'NA',
            Pos:   buyerSt,
            Addr1: ((customer && customer.billing_address) || 'NA').slice(0, 100),
            Loc:   ((customer && customer.billing_address) || 'NA').slice(0, 50),
            Pin:   0,
            Stcd:  buyerSt,
        },
        ItemList: (items || []).map((it, i) => {
            const gstAmt = Number(it.gst_amount) || 0;
            return {
                SlNo:       String(i + 1),
                PrdDesc:    (it.description || 'Item').slice(0, 300),
                IsServc:    'N',
                HsnCd:      it.hsn || '',
                Qty:        Number(it.quantity) || 0,
                Unit:       it.unit || 'NOS',
                UnitPrice:  Number(it.rate) || 0,
                TotAmt:     r2(Number(it.rate) * Number(it.quantity)),
                Discount:   Number(it.discount_pct ? (Number(it.rate) * Number(it.quantity) * it.discount_pct / 100) : 0),
                AssAmt:     Number(it.taxable) || 0,
                GstRt:      Number(it.gst_rate) || 0,
                CgstAmt:    intra ? r2(gstAmt / 2) : 0,
                SgstAmt:    intra ? r2(gstAmt / 2) : 0,
                IgstAmt:    intra ? 0 : r2(gstAmt),
                TotItemVal: Number(it.amount) || 0,
            };
        }),
        ValDtls: {
            AssVal:    Number(invoice.taxable) || 0,
            CgstVal:   Number(invoice.cgst) || 0,
            SgstVal:   Number(invoice.sgst) || 0,
            IgstVal:   Number(invoice.igst) || 0,
            RndOffAmt: Number(invoice.round_off) || 0,
            TotInvVal: Number(invoice.total) || 0,
        },
    };
}

/** True when a GSP is wired in the env. */
function gspConfigured() {
    return !!(process.env.EINVOICE_GSP_URL || '').trim() && !!(process.env.EINVOICE_GSP_KEY || '').trim();
}

/** Call the configured GSP to mint an IRN. Returns { irn, ack_no, ack_date,
 * qr_code, ewb_no?, ... } or null when no GSP is configured (→ manual entry). */
async function callGsp(payload) {
    if (!gspConfigured()) return null;
    const url = process.env.EINVOICE_GSP_URL.trim();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EINVOICE_GSP_KEY.trim()}` },
        body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && (body.message || body.error)) || `GSP HTTP ${res.status}`);
    // Providers vary — map the common fields (adjust when the real GSP is chosen).
    return {
        irn:      body.Irn || body.irn,
        ack_no:   body.AckNo || body.ackNo,
        ack_date: body.AckDt || body.ackDt,
        qr_code:  body.SignedQRCode || body.qrCode,
        ewb_no:   body.EwbNo || body.ewbNo || null,
    };
}

module.exports = { buildPayload, stateCode, gspConfigured, callGsp };
