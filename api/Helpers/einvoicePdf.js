'use strict';

/**
 * api/Helpers/einvoicePdf.js
 *
 * Renders a GST **e-Invoice + e-Way Bill** into a clean, print-ready PDF that
 * mirrors the official NIC/IRP document layout (NOT the raw JSON payload):
 *
 *   ┌ e-Invoice header — IRN, Ack No/Date + the signed QR image
 *   ├ 1. Transaction / Document details
 *   ├ 2. Party details (Supplier → Recipient)
 *   ├ 3. e-Way Bill details (EWB no, validity, transport, vehicle)  [if present]
 *   ├ 4. Goods details table (HSN · qty · rate · taxable · GST split)
 *   └ Value summary (taxable, CGST/SGST/IGST, round-off, total)
 *
 * The SAME PDF is served to web (download/email) and the mobile app (they hit
 * the same API endpoints), so the format is guaranteed identical everywhere.
 * Helpers/pdf.js turns the returned HTML into a PDF via Puppeteer.
 */

const QRCode = require('qrcode');
const { htmlToPdf } = require('./pdf');
const BRAND = require('../config/brand');

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** ₹ with Indian digit grouping, 2 decimals; blank for null/empty. */
function inr(n) {
    if (n == null || n === '') return '';
    const num = Number(n);
    if (!Number.isFinite(num)) return esc(n);
    const neg = num < 0;
    const [whole, frac] = Math.abs(num).toFixed(2).split('.');
    let last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    if (rest) last3 = ',' + last3;
    const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
    return (neg ? '-' : '') + '₹' + grouped + '.' + frac;
}

function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt)) return esc(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

function fmtDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt)) return esc(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

const TRANSPORT_MODE = { 1: 'Road', 2: 'Rail', 3: 'Air', 4: 'Ship', 5: 'In-transit' };
const SUPPLY_LABEL = { B2B: 'B2B', SEZWP: 'SEZ with payment', SEZWOP: 'SEZ without payment', EXPWP: 'Export with payment', EXPWOP: 'Export without payment', DEXP: 'Deemed export' };
const DOC_LABEL = { INV: 'Tax Invoice', CRN: 'Credit Note', DBN: 'Debit Note' };

/** GST state code = first two digits of the GSTIN. */
function stateCode(gstin) {
    return gstin && String(gstin).length >= 2 ? String(gstin).slice(0, 2) : '';
}

/** Normalise an invoice_items row (matches Helpers/einvoice.buildPayload). */
function normItem(it, intra) {
    const gstAmt = Number(it.gst_amount) || 0;
    return {
        desc: it.description || it.item_name || it.product_name || 'Item',
        hsn:  it.hsn || '',
        qty:  it.quantity != null ? it.quantity : (it.qty != null ? it.qty : ''),
        unit: it.unit || '',
        rate: it.rate,
        disc: it.discount_pct != null ? it.discount_pct : '',
        taxable: it.taxable,
        gst:  it.gst_rate != null ? it.gst_rate : '',
        cgst: intra ? gstAmt / 2 : 0,
        sgst: intra ? gstAmt / 2 : 0,
        igst: intra ? 0 : gstAmt,
        amount: it.amount,
    };
}

/**
 * Build the e-Invoice/e-Way Bill HTML.
 * @param {object} args { ei, inv, items, company, customer, qrDataUrl }
 * @returns {string} a complete, self-styled HTML document.
 */
function buildEinvoiceHtml({ ei, inv, items, company, customer, qrDataUrl }) {
    ei = ei || {}; inv = inv || {}; company = company || {}; customer = customer || {};
    const sellerGstin = ei.gstin || company.gst_number || '';
    const buyerGstin = (customer && customer.gst_number) || '';
    const sellerSt = stateCode(sellerGstin);
    const buyerSt = buyerGstin ? stateCode(buyerGstin) : sellerSt;
    const intra = buyerSt === sellerSt;

    const hasIrn = !!ei.irn;
    const hasEwb = !!ei.ewb_no;
    const docLabel = DOC_LABEL[ei.doc_type] || 'Tax Invoice';

    const rows = (items || []).map((it) => normItem(it, intra));
    const rowsHtml = rows.length
        ? rows.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.desc)}</td>
            <td class="c">${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td class="c">${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.taxable)}</td>
            <td class="c">${it.gst !== '' && it.gst != null ? esc(it.gst) + '%' : ''}</td>
            ${intra
                ? `<td class="num">${inr(it.cgst)}</td><td class="num">${inr(it.sgst)}</td>`
                : `<td class="num">${inr(it.igst)}</td>`}
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="${intra ? 12 : 11}" class="empty">No line items.</td></tr>`;

    const num = (v) => Number(v || 0);
    const valRows = [];
    valRows.push(['Taxable Value', inr(inv.taxable)]);
    if (num(inv.cgst)) valRows.push(['CGST', inr(inv.cgst)]);
    if (num(inv.sgst)) valRows.push(['SGST', inr(inv.sgst)]);
    if (num(inv.igst)) valRows.push(['IGST', inr(inv.igst)]);
    if (num(inv.discount)) valRows.push(['Discount', '-' + inr(inv.discount)]);
    if (num(inv.round_off)) valRows.push(['Round Off', inr(inv.round_off)]);
    const valHtml = valRows.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="num">${v}</td></tr>`).join('')
        + `<tr class="grand"><td>Total Invoice Value</td><td class="num">${inr(inv.total)}</td></tr>`;

    const kv = (label, value) => `<div class="kv"><span>${esc(label)}</span><b>${value}</b></div>`;

    // ── e-Way Bill block (only when an EWB exists) ───────────────────
    const ewbBlock = hasEwb ? `
      <div class="section">
        <div class="sec-title">e-Way Bill Details</div>
        <div class="kvgrid">
          ${kv('e-Way Bill No', esc(ei.ewb_no))}
          ${kv('EWB Date', fmtDate(ei.ewb_date || ei.generated_at))}
          ${kv('Valid Until', fmtDateTime(ei.ewb_valid_until))}
          ${kv('Distance', ei.distance_km ? esc(ei.distance_km) + ' km' : '—')}
          ${kv('Mode', esc(TRANSPORT_MODE[ei.transport_mode] || 'Road'))}
          ${kv('Vehicle No', esc(ei.vehicle_no || '—'))}
          ${kv('Transporter', esc(ei.transporter || '—'))}
          ${kv('Transporter ID', esc(ei.transporter_id || '—'))}
        </div>
      </div>` : '';

    // ── QR image (signed e-invoice QR, else EWB compact code) ─────────
    const qrImg = qrDataUrl
        ? `<div class="qr"><img src="${qrDataUrl}" alt="QR"><div class="qrcap">${hasIrn ? 'Signed QR' : 'e-Way QR'}</div></div>`
        : '';

    const title = hasEwb && !hasIrn ? 'e-Way Bill' : (hasIrn ? 'e-Invoice' : 'GST Document');
    const subtitle = hasEwb && hasIrn ? 'e-Invoice & e-Way Bill' : title;

    return `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1f2937; margin:0; font-size:11px; }
      .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #2563eb; padding-bottom:10px; margin-bottom:12px; }
      .head .co { font-size:17px; font-weight:700; color:#111827; }
      .head .cometa { font-size:10.5px; color:#6b7280; margin-top:2px; line-height:1.5; }
      .head .title { text-align:right; }
      .head .title .t { font-size:18px; font-weight:800; color:#2563eb; letter-spacing:.02em; }
      .head .title .st { font-size:10px; color:#6b7280; margin-top:2px; }

      .irnbar { display:flex; justify-content:space-between; gap:14px; background:#f8fafc; border:1px solid #e5e7eb; border-radius:8px; padding:10px 12px; margin-bottom:12px; }
      .irnbar .fields { flex:1; }
      .irnbar .kv { display:flex; gap:8px; margin-bottom:3px; }
      .irnbar .kv span { color:#6b7280; min-width:78px; }
      .irnbar .kv b { color:#111827; word-break:break-all; font-weight:600; }
      .qr { text-align:center; }
      .qr img { width:118px; height:118px; }
      .qrcap { font-size:9px; color:#6b7280; margin-top:2px; }

      .section { border:1px solid #e5e7eb; border-radius:8px; margin-bottom:10px; overflow:hidden; }
      .sec-title { background:#f3f4f6; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:#374151; padding:6px 12px; border-bottom:1px solid #e5e7eb; }
      .kvgrid { display:grid; grid-template-columns:1fr 1fr; gap:4px 18px; padding:10px 12px; }
      .kv { display:flex; gap:8px; }
      .kv span { color:#6b7280; min-width:96px; }
      .kv b { color:#111827; font-weight:600; }

      .parties { display:grid; grid-template-columns:1fr 1fr; gap:0; }
      .party { padding:10px 12px; }
      .party + .party { border-left:1px solid #e5e7eb; }
      .party .plbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:#6b7280; margin-bottom:3px; }
      .party .pname { font-size:12.5px; font-weight:700; color:#111827; }
      .party .pline { font-size:10.5px; color:#4b5563; margin-top:2px; line-height:1.5; }

      table.rpt { width:100%; border-collapse:collapse; }
      table.rpt th, table.rpt td { border:1px solid #e5e7eb; padding:5px 6px; text-align:left; vertical-align:top; }
      table.rpt th { background:#f3f4f6; font-weight:700; font-size:9px; text-transform:uppercase; color:#374151; }
      table.rpt td.num, table.rpt th.num { text-align:right; white-space:nowrap; }
      table.rpt td.c, table.rpt th.c { text-align:center; }
      .empty { color:#6b7280; text-align:center; padding:16px; }

      .val-wrap { display:flex; justify-content:flex-end; margin-top:10px; }
      table.val { border-collapse:collapse; min-width:260px; }
      table.val td { padding:5px 12px; font-size:11px; border:1px solid #e5e7eb; }
      table.val td:last-child { text-align:right; white-space:nowrap; }
      table.val tr.grand td { font-weight:800; font-size:12.5px; background:#eff6ff; color:#111827; }

      .foot { margin-top:18px; font-size:9px; color:#9ca3af; text-align:center; border-top:1px solid #e5e7eb; padding-top:8px; }
    </style></head><body>

      <div class="head">
        <div>
          <div class="co">${esc(company.mailing_name || company.name || 'Company')}</div>
          <div class="cometa">
            ${sellerGstin ? 'GSTIN: ' + esc(sellerGstin) + '<br>' : ''}
            ${company.address ? esc(company.address) + '<br>' : ''}
            ${company.pincode ? 'PIN: ' + esc(company.pincode) : ''}
          </div>
        </div>
        <div class="title">
          <div class="t">${esc(title)}</div>
          <div class="st">${esc(subtitle)}</div>
        </div>
      </div>

      <div class="irnbar">
        <div class="fields">
          ${hasIrn ? `<div class="kv"><span>IRN</span><b>${esc(ei.irn)}</b></div>` : ''}
          ${hasIrn ? `<div class="kv"><span>Ack No</span><b>${esc(ei.ack_no || '—')}</b></div>` : ''}
          ${hasIrn ? `<div class="kv"><span>Ack Date</span><b>${fmtDateTime(ei.ack_date)}</b></div>` : ''}
          <div class="kv"><span>Invoice No</span><b>${esc(inv.invoice_no || '—')}</b></div>
          <div class="kv"><span>Invoice Date</span><b>${fmtDate(inv.invoice_date)}</b></div>
        </div>
        ${qrImg}
      </div>

      <div class="section">
        <div class="sec-title">Document Details</div>
        <div class="kvgrid">
          ${kv('Supply Type', esc(SUPPLY_LABEL[ei.supply_type] || ei.supply_type || 'B2B'))}
          ${kv('Document Type', esc(docLabel))}
          ${kv('Document No', esc(inv.invoice_no || '—'))}
          ${kv('Document Date', fmtDate(inv.invoice_date))}
          ${kv('Place of Supply', esc(buyerSt || sellerSt || '—'))}
          ${kv('Tax Type', intra ? 'Intra-State (CGST + SGST)' : 'Inter-State (IGST)')}
        </div>
      </div>

      <div class="section">
        <div class="sec-title">Party Details</div>
        <div class="parties">
          <div class="party">
            <div class="plbl">Supplier (From)</div>
            <div class="pname">${esc(company.mailing_name || company.name || '—')}</div>
            <div class="pline">
              ${sellerGstin ? 'GSTIN: ' + esc(sellerGstin) + '<br>' : ''}
              ${company.address ? esc(company.address) : ''}
              ${company.pincode ? '<br>PIN: ' + esc(company.pincode) : ''}
            </div>
          </div>
          <div class="party">
            <div class="plbl">Recipient (To)</div>
            <div class="pname">${esc(customer.name || 'Cash / Walk-in')}</div>
            <div class="pline">
              ${buyerGstin ? 'GSTIN: ' + esc(buyerGstin) + '<br>' : 'GSTIN: URP<br>'}
              ${customer.billing_address ? esc(customer.billing_address) : ''}
              ${customer.mobile ? '<br>Ph: ' + esc(customer.mobile) : ''}
            </div>
          </div>
        </div>
      </div>

      ${ewbBlock}

      <div class="section" style="border:none">
        <div class="sec-title" style="border:1px solid #e5e7eb; border-bottom:none; border-radius:8px 8px 0 0">Goods / Item Details</div>
        <table class="rpt">
          <thead><tr>
            <th class="c">#</th><th>Description</th><th class="c">HSN</th>
            <th class="num">Qty</th><th class="c">Unit</th><th class="num">Rate</th>
            <th class="num">Disc</th><th class="num">Taxable</th><th class="c">GST%</th>
            ${intra ? '<th class="num">CGST</th><th class="num">SGST</th>' : '<th class="num">IGST</th>'}
            <th class="num">Total</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      <div class="val-wrap"><table class="val">${valHtml}</table></div>

      ${inv.notes ? `<div style="margin-top:12px; font-size:10.5px; color:#374151"><b>Notes:</b> ${esc(inv.notes)}</div>` : ''}

      <div class="foot">
        This is a system-generated GST ${esc(subtitle)} · Generated from ${BRAND.name} · ${BRAND.tagline}
      </div>
    </body></html>`;
}

/**
 * Render the e-Invoice/e-Way Bill to a PDF Buffer.
 * @param {object} args { ei, inv, items, company, customer }
 * @returns {Promise<Buffer>}
 */
async function renderEinvoicePdf(args) {
    const ei = args.ei || {};
    // QR content: prefer the IRP signed QR (JWT); else a compact e-Way code; else IRN.
    let qrText = ei.signed_qr || ei.qr_code || '';
    if (!qrText && ei.ewb_no) {
        qrText = [ei.ewb_no, ei.gstin || '', fmtDate(ei.ewb_date || ei.generated_at)].join('/');
    }
    if (!qrText && ei.irn) qrText = ei.irn;

    let qrDataUrl = '';
    if (qrText) {
        try {
            qrDataUrl = await QRCode.toDataURL(String(qrText), { margin: 1, width: 240, errorCorrectionLevel: 'M' });
        } catch (_) { qrDataUrl = ''; }
    }

    const html = buildEinvoiceHtml({ ...args, qrDataUrl });
    return htmlToPdf(html, { format: 'A4', landscape: false });
}

/** Suggested download filename for this document. */
function einvoiceFilename(ei, inv) {
    const base = (ei && ei.ewb_no) ? `eway-${ei.ewb_no}`
        : (inv && inv.invoice_no) ? `einvoice-${String(inv.invoice_no).replace(/[^\w.-]+/g, '_')}`
        : `einvoice-${(ei && ei.id) || 'doc'}`;
    return `${base}.pdf`;
}

module.exports = { buildEinvoiceHtml, renderEinvoicePdf, einvoiceFilename };
