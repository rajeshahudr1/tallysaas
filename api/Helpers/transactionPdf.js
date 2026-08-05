'use strict';

/**
 * api/Helpers/transactionPdf.js
 *
 * Renders a sales/purchase INVOICE (the rich detail from InvoiceController.get)
 * into a clean, print-ready, data-only HTML document — company header, party
 * block, line-items table and a tax/total summary. Helpers/pdf.js turns the
 * returned HTML into a PDF via Puppeteer (same pipeline as the reports).
 *
 * Uses `tally_items` (the synced line items) when present, else `items`.
 */

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
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return esc(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

// Normalise a line item from either tally_items or items into one shape.
function normItem(it) {
    return {
        name: it.item_name || it.product_name || it.name || '',
        hsn:  it.hsn || '',
        qty:  it.qty != null ? it.qty : (it.quantity != null ? it.quantity : ''),
        unit: it.unit || '',
        rate: it.rate,
        disc: it.disc_pct != null ? it.disc_pct : (it.discount_pct != null ? it.discount_pct : ''),
        gst:  it.gst_rate != null ? it.gst_rate : (it.gst != null ? it.gst : ''),
        amount: it.amount,
    };
}

/** Build invoice PDF HTML. inv = InvoiceController.get's data object. */
function invoicePdfHtml(inv, ctx = {}) {
    const isSales = (inv.type || 'sales') === 'sales';
    const title = isSales ? 'TAX INVOICE' : 'PURCHASE INVOICE';
    const party = inv.customer || inv.supplier || null;
    const partyLabel = isSales ? 'Bill To' : 'From';
    const partyName = party ? (party.name || '') : (isSales ? 'Cash / Walk-in' : '');
    const partyGstin = party ? (party.gstin || party.gst_no || '') : '';

    const src = (Array.isArray(inv.tally_items) && inv.tally_items.length) ? inv.tally_items
        : (Array.isArray(inv.items) ? inv.items : []);
    const items = src.map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', inv.taxable);
    if (num(inv.cgst))     totals += totalRow('CGST', inv.cgst);
    if (num(inv.sgst))     totals += totalRow('SGST', inv.sgst);
    if (num(inv.igst))     totals += totalRow('IGST', inv.igst);
    if (num(inv.discount)) totals += totalRow('Discount', inv.discount);
    if (num(inv.round_off)) totals += totalRow('Round Off', inv.round_off);
    totals += totalRow('Total', inv.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Invoice No</span><b>${esc(inv.invoice_no || inv.tally_voucher_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(inv.invoice_date)}</b></div>
          ${inv.tally_voucher_type ? `<div><span>Voucher Type</span><b>${esc(inv.tally_voucher_type)}</b></div>` : ''}
          ${inv.supplier_bill_no ? `<div><span>Bill No</span><b>${esc(inv.supplier_bill_no)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${inv.notes ? `<div class="notes"><b>Notes:</b> ${esc(inv.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

/**
 * Build quotation PDF HTML. q = QuotationController.get's data object.
 * Same layout as invoicePdfHtml but titled "QUOTATION", shows a "Valid till"
 * line instead of a due date, and never shows "Amount Due" (a quotation has
 * no payment lifecycle).
 */
function quotationPdfHtml(q, ctx = {}) {
    const title = 'QUOTATION';
    const party = q.customer || null;
    const partyLabel = 'Bill To';
    const partyName = (typeof party === 'string' && party) || (party && party.name) || 'Cash / Walk-in';
    const partyGstin = (party && (party.gstin || party.gst_no)) || '';

    const items = (Array.isArray(q.items) ? q.items : []).map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', q.taxable);
    if (num(q.cgst))     totals += totalRow('CGST', q.cgst);
    if (num(q.sgst))     totals += totalRow('SGST', q.sgst);
    if (num(q.igst))     totals += totalRow('IGST', q.igst);
    if (num(q.discount)) totals += totalRow('Discount', q.discount);
    if (num(q.round_off)) totals += totalRow('Round Off', q.round_off);
    totals += totalRow('Total', q.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Quotation No</span><b>${esc(q.quotation_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(q.quotation_date)}</b></div>
          ${q.valid_till ? `<div><span>Valid till</span><b>${fmtDate(q.valid_till)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${q.notes ? `<div class="notes"><b>Notes:</b> ${esc(q.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

/**
 * Build sales-order PDF HTML. o = SalesOrderController.get's data object.
 * Same layout as quotationPdfHtml but titled "SALES ORDER" and shows a
 * "Due on" line (delivery commitment) instead of "Valid till".
 */
function salesOrderPdfHtml(o, ctx = {}) {
    const title = 'SALES ORDER';
    const party = o.customer || null;
    const partyLabel = 'Bill To';
    const partyName = (typeof party === 'string' && party) || (party && party.name) || 'Cash / Walk-in';
    const partyGstin = (party && (party.gstin || party.gst_no)) || '';

    const items = (Array.isArray(o.items) ? o.items : []).map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', o.taxable);
    if (num(o.cgst))     totals += totalRow('CGST', o.cgst);
    if (num(o.sgst))     totals += totalRow('SGST', o.sgst);
    if (num(o.igst))     totals += totalRow('IGST', o.igst);
    if (num(o.discount)) totals += totalRow('Discount', o.discount);
    if (num(o.round_off)) totals += totalRow('Round Off', o.round_off);
    totals += totalRow('Total', o.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Order No</span><b>${esc(o.order_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(o.order_date)}</b></div>
          ${o.due_on ? `<div><span>Due on</span><b>${fmtDate(o.due_on)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${o.notes ? `<div class="notes"><b>Notes:</b> ${esc(o.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

/**
 * Build purchase-order PDF HTML. o = PurchaseOrderController.get's data
 * object. Same layout as salesOrderPdfHtml but titled "PURCHASE ORDER", the
 * party is a supplier ("From"), and shows a "Due on" line (delivery
 * commitment) instead of "Valid till".
 */
function purchaseOrderPdfHtml(o, ctx = {}) {
    const title = 'PURCHASE ORDER';
    const party = o.supplier || null;
    const partyLabel = 'From';
    const partyName = (typeof party === 'string' && party) || (party && party.name) || '';
    const partyGstin = (party && (party.gstin || party.gst_no)) || '';

    const items = (Array.isArray(o.items) ? o.items : []).map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', o.taxable);
    if (num(o.cgst))     totals += totalRow('CGST', o.cgst);
    if (num(o.sgst))     totals += totalRow('SGST', o.sgst);
    if (num(o.igst))     totals += totalRow('IGST', o.igst);
    if (num(o.discount)) totals += totalRow('Discount', o.discount);
    if (num(o.round_off)) totals += totalRow('Round Off', o.round_off);
    totals += totalRow('Total', o.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Order No</span><b>${esc(o.order_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(o.order_date)}</b></div>
          ${o.due_on ? `<div><span>Due on</span><b>${fmtDate(o.due_on)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${o.notes ? `<div class="notes"><b>Notes:</b> ${esc(o.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

/**
 * Build delivery-note PDF HTML. o = DeliveryNoteController.get's data
 * object. Same layout as salesOrderPdfHtml but titled "DELIVERY NOTE", shows
 * a "Dispatch date" line (the day goods actually left) instead of "Due on",
 * and cites the referenced sales order (if any) via "Against SO".
 */
function deliveryNotePdfHtml(o, ctx = {}) {
    const title = 'DELIVERY NOTE';
    const party = o.customer || null;
    const partyLabel = 'Bill To';
    const partyName = (typeof party === 'string' && party) || (party && party.name) || 'Cash / Walk-in';
    const partyGstin = (party && (party.gstin || party.gst_no)) || '';

    const items = (Array.isArray(o.items) ? o.items : []).map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', o.taxable);
    if (num(o.cgst))     totals += totalRow('CGST', o.cgst);
    if (num(o.sgst))     totals += totalRow('SGST', o.sgst);
    if (num(o.igst))     totals += totalRow('IGST', o.igst);
    if (num(o.discount)) totals += totalRow('Discount', o.discount);
    if (num(o.round_off)) totals += totalRow('Round Off', o.round_off);
    totals += totalRow('Total', o.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Note No</span><b>${esc(o.note_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(o.note_date)}</b></div>
          ${o.dispatch_date ? `<div><span>Dispatch date</span><b>${fmtDate(o.dispatch_date)}</b></div>` : ''}
          ${o.sales_order_id ? `<div><span>Against SO</span><b>#${esc(o.sales_order_id)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${o.notes ? `<div class="notes"><b>Notes:</b> ${esc(o.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

function receiptNotePdfHtml(o, ctx = {}) {
    const title = 'RECEIPT NOTE';
    const party = o.supplier || null;
    const partyLabel = 'Received From';
    const partyName = (typeof party === 'string' && party) || (party && party.name) || 'Cash / Walk-in';
    const partyGstin = (party && (party.gstin || party.gst_no)) || '';

    const items = (Array.isArray(o.items) ? o.items : []).map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', o.taxable);
    if (num(o.cgst))     totals += totalRow('CGST', o.cgst);
    if (num(o.sgst))     totals += totalRow('SGST', o.sgst);
    if (num(o.igst))     totals += totalRow('IGST', o.igst);
    if (num(o.discount)) totals += totalRow('Discount', o.discount);
    if (num(o.round_off)) totals += totalRow('Round Off', o.round_off);
    totals += totalRow('Total', o.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Note No</span><b>${esc(o.note_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(o.note_date)}</b></div>
          ${o.received_date ? `<div><span>Received on</span><b>${fmtDate(o.received_date)}</b></div>` : ''}
          ${o.purchase_order_id ? `<div><span>Against PO</span><b>#${esc(o.purchase_order_id)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${o.notes ? `<div class="notes"><b>Notes:</b> ${esc(o.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

/**
 * Build a Credit Note / Debit Note PDF HTML. note = ReturnNoteController.get's
 * data object (a row from the shared `invoices` table); `kind` is 'credit' |
 * 'debit'. Same layout as invoicePdfHtml but titled "CREDIT NOTE"/"DEBIT
 * NOTE" and cites the original bill (if any) via "Against Bill".
 */
function returnNotePdfHtml(note, ctx = {}, kind = 'credit') {
    const isCredit = kind === 'credit';
    const title = isCredit ? 'CREDIT NOTE' : 'DEBIT NOTE';
    const party = note.customer || note.supplier || null;
    const partyLabel = isCredit ? 'Bill To' : 'From';
    const partyName = party ? (party.name || '') : '';
    const partyGstin = party ? (party.gstin || party.gst_no || '') : '';

    const src = (Array.isArray(note.tally_items) && note.tally_items.length) ? note.tally_items
        : (Array.isArray(note.items) ? note.items : []);
    const items = src.map(normItem);

    const rowsHtml = items.length
        ? items.map((it, i) => `<tr>
            <td class="c">${i + 1}</td>
            <td>${esc(it.name)}</td>
            <td>${esc(it.hsn)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td>${esc(it.unit)}</td>
            <td class="num">${inr(it.rate)}</td>
            <td class="num">${it.disc !== '' && it.disc != null ? esc(it.disc) + '%' : ''}</td>
            <td class="num">${inr(it.amount)}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No line items.</td></tr>`;

    const totalRow = (label, val, strong) =>
        `<tr${strong ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${inr(val)}</td></tr>`;

    const num = (v) => Number(v || 0);
    let totals = '';
    totals += totalRow('Taxable', note.taxable);
    if (num(note.cgst))      totals += totalRow('CGST', note.cgst);
    if (num(note.sgst))      totals += totalRow('SGST', note.sgst);
    if (num(note.igst))      totals += totalRow('IGST', note.igst);
    if (num(note.discount))  totals += totalRow('Discount', note.discount);
    if (num(note.round_off)) totals += totalRow('Round Off', note.round_off);
    totals += totalRow('Total', note.total, true);

    const inner = `
      <div class="meta-grid">
        <div class="party">
          <div class="lbl">${esc(partyLabel)}</div>
          <div class="pname">${esc(partyName) || '—'}</div>
          ${partyGstin ? `<div class="pgst">GSTIN: ${esc(partyGstin)}</div>` : ''}
        </div>
        <div class="inv-meta">
          <div><span>Note No</span><b>${esc(note.invoice_no || note.tally_voucher_no || '')}</b></div>
          <div><span>Date</span><b>${fmtDate(note.invoice_date)}</b></div>
          ${note.against_invoice_id ? `<div><span>Against Bill</span><b>#${esc(note.against_invoice_id)}</b></div>` : ''}
          ${note.supplier_bill_no ? `<div><span>Bill No</span><b>${esc(note.supplier_bill_no)}</b></div>` : ''}
        </div>
      </div>
      <table class="rpt">
        <thead><tr>
          <th class="c">#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Rate</th><th class="num">Disc</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals-wrap"><table class="totals">${totals}</table></div>
      ${note.notes ? `<div class="notes"><b>Notes:</b> ${esc(note.notes)}</div>` : ''}`;

    return { html: wrap(ctx, title, inner), landscape: false };
}

function wrap(ctx, title, inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1f2937; margin:0; font-size:12px; }
      .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #2563eb; padding-bottom:10px; margin-bottom:14px; }
      .head .co { font-size:18px; font-weight:700; color:#111827; }
      .head .meta { font-size:11px; color:#6b7280; margin-top:2px; }
      .head .title { font-size:16px; font-weight:700; color:#2563eb; text-align:right; }
      .head .title small { display:block; font-size:11px; color:#6b7280; font-weight:400; margin-top:2px; }
      .meta-grid { display:flex; justify-content:space-between; gap:16px; margin-bottom:12px; }
      .party .lbl { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:#6b7280; }
      .party .pname { font-size:14px; font-weight:700; color:#111827; }
      .party .pgst { font-size:11px; color:#6b7280; }
      .inv-meta div { display:flex; gap:10px; justify-content:flex-end; font-size:11px; margin-bottom:2px; }
      .inv-meta span { color:#6b7280; }
      .inv-meta b { color:#111827; min-width:90px; text-align:right; }
      table.rpt { width:100%; border-collapse:collapse; }
      table.rpt th, table.rpt td { border:1px solid #e5e7eb; padding:6px 8px; text-align:left; vertical-align:top; }
      table.rpt th { background:#f3f4f6; font-weight:600; font-size:10.5px; text-transform:uppercase; color:#374151; }
      table.rpt td.num, table.rpt th.num { text-align:right; white-space:nowrap; }
      table.rpt td.c, table.rpt th.c { text-align:center; }
      .empty { color:#6b7280; text-align:center; padding:18px; }
      .totals-wrap { display:flex; justify-content:flex-end; margin-top:10px; }
      table.totals { border-collapse:collapse; min-width:240px; }
      table.totals td { padding:5px 10px; font-size:12px; }
      table.totals td:last-child { text-align:right; white-space:nowrap; }
      table.totals tr.grand td { font-weight:700; font-size:13px; border-top:2px solid #d1d5db; color:#111827; }
      .notes { margin-top:14px; font-size:11px; color:#374151; }
      .foot { margin-top:20px; font-size:10px; color:#9ca3af; text-align:center; border-top:1px solid #e5e7eb; padding-top:8px; }
    </style></head><body>
      <div class="head">
        <div><div class="co">${esc(ctx.companyName || 'Company')}</div>
          ${ctx.companyGstin ? `<div class="meta">GSTIN: ${esc(ctx.companyGstin)}</div>` : ''}</div>
        <div class="title">${esc(title)}<small>${esc(ctx.generatedAt || '')}</small></div>
      </div>
      ${inner}
      <div class="foot">Generated from Tally Cloud Sync${ctx.generatedAt ? ' · ' + esc(ctx.generatedAt) : ''}</div>
    </body></html>`;
}

module.exports = { invoicePdfHtml, quotationPdfHtml, salesOrderPdfHtml, purchaseOrderPdfHtml, deliveryNotePdfHtml, receiptNotePdfHtml, returnNotePdfHtml };
