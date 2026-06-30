'use strict';

/**
 * api/Helpers/reportPdf.js
 *
 * Turns a report's JSON body (the SAME data the /reports/* endpoints return)
 * into a clean, print-ready, data-ONLY HTML document — no sidebar, no nav, no
 * buttons. Helpers/pdf.js renders the returned HTML to a PDF via Puppeteer, so
 * every report downloads as a tidy A4 sheet on web + mobile.
 *
 * Shapes handled:
 *   • balance-sheet / profit-loss → two-side statement (Liab|Assets, Exp|Income)
 *   • trial-balance / sales-register / stock-summary / day-book / outstanding /
 *     ledger → a generic table built from the `data`/`rows` array
 *   • gst-summary → an Output-vs-Input GST block
 */

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** ₹ with Indian digit grouping, 2 decimals; blank for null/undefined. */
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

const _NUM_KEYS = /^(amount|total|taxable|tax|cgst|sgst|igst|value|rate|debit|credit|opening|closing|balance|qty|quantity|net|price|payable)/i;
function looksNumericKey(k) { return _NUM_KEYS.test(String(k)); }

function prettyKey(k) {
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A two-side statement (Balance Sheet / P&L). rows = [{label, amount}]. */
function twoSide(leftLabel, left, leftTotal, rightLabel, right, rightTotal) {
    const max = Math.max(left.length, right.length);
    let body = '';
    for (let i = 0; i < max; i++) {
        const l = left[i], r = right[i];
        body += '<tr>' +
            `<td>${l ? esc(l.label) : ''}</td>` +
            `<td class="num">${l ? inr(l.amount) : ''}</td>` +
            `<td>${r ? esc(r.label) : ''}</td>` +
            `<td class="num">${r ? inr(r.amount) : ''}</td>` +
            '</tr>';
    }
    return `<table class="rpt rpt--two">
      <thead><tr><th>${esc(leftLabel)}</th><th class="num">Amount</th><th>${esc(rightLabel)}</th><th class="num">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${inr(leftTotal)}</td><td>Total</td><td class="num">${inr(rightTotal)}</td></tr></tfoot>
    </table>`;
}

/** A generic table from an array of row objects. Columns = the row keys. */
function genericTable(rows, totals) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return '<p class="empty">No data for this report.</p>';
    }
    const cols = Object.keys(rows[0]);
    const head = cols.map((c) => `<th class="${looksNumericKey(c) ? 'num' : ''}">${esc(prettyKey(c))}</th>`).join('');
    const body = rows.map((row) => '<tr>' + cols.map((c) => {
        const v = row[c];
        const numeric = looksNumericKey(c) && typeof v !== 'string';
        return `<td class="${looksNumericKey(c) ? 'num' : ''}">${numeric ? inr(v) : esc(v)}</td>`;
    }).join('') + '</tr>').join('');
    let foot = '';
    if (totals && typeof totals === 'object') {
        foot = '<tfoot><tr>' + cols.map((c, i) => {
            if (i === 0) return '<td>Total</td>';
            const t = totals[c];
            return `<td class="num">${t == null ? '' : inr(t)}</td>`;
        }).join('') + '</tr></tfoot>';
    }
    return `<table class="rpt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

/** GST summary — Output vs Input + net payable. */
function gstHtml(body) {
    const o = body.outward || {}, i = body.inward || {};
    const row = (label, x) =>
        `<tr><td>${label}</td><td class="num">${inr(x.taxable)}</td><td class="num">${inr(x.cgst)}</td>` +
        `<td class="num">${inr(x.sgst)}</td><td class="num">${inr(x.igst)}</td><td class="num">${inr(x.tax)}</td></tr>`;
    return `<table class="rpt">
      <thead><tr><th></th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total Tax</th></tr></thead>
      <tbody>${row('Output GST (Sales)', o)}${row('Input GST (Purchases)', i)}</tbody>
      <tfoot><tr><td>Net GST Payable</td><td colspan="5" class="num">${inr(body.net_payable)}</td></tr></tfoot>
    </table>`;
}

/** Wrap a report body in the full, self-styled HTML document. */
function wrap(ctx, inner) {
    return `<!doctype html><html><head><meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; font-size: 12px; }
      .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #2563eb; padding-bottom:10px; margin-bottom:14px; }
      .head .co { font-size:18px; font-weight:700; color:#111827; }
      .head .meta { font-size:11px; color:#6b7280; margin-top:2px; }
      .head .title { font-size:16px; font-weight:700; color:#2563eb; text-align:right; }
      .head .title small { display:block; font-size:11px; color:#6b7280; font-weight:400; margin-top:2px; }
      table.rpt { width:100%; border-collapse:collapse; }
      table.rpt th, table.rpt td { border:1px solid #e5e7eb; padding:6px 9px; text-align:left; vertical-align:top; }
      table.rpt th { background:#f3f4f6; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.02em; color:#374151; }
      table.rpt td.num, table.rpt th.num { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
      table.rpt tfoot td { font-weight:700; background:#f9fafb; border-top:2px solid #d1d5db; }
      table.rpt--two td:nth-child(3), table.rpt--two th:nth-child(3) { border-left:2px solid #d1d5db; }
      .empty { color:#6b7280; padding:24px; text-align:center; }
      .foot { margin-top:18px; font-size:10px; color:#9ca3af; text-align:center; border-top:1px solid #e5e7eb; padding-top:8px; }
    </style></head><body>
      <div class="head">
        <div>
          <div class="co">${esc(ctx.companyName || 'Company')}</div>
          ${ctx.subtitle ? `<div class="meta">${esc(ctx.subtitle)}</div>` : ''}
        </div>
        <div class="title">${esc(ctx.title)}<small>${esc(ctx.generatedAt || '')}</small></div>
      </div>
      ${inner}
      <div class="foot">Generated from Tally Cloud Sync${ctx.generatedAt ? ' · ' + esc(ctx.generatedAt) : ''}</div>
    </body></html>`;
}

/** Build the report PDF HTML for [type] from its JSON [body]. */
function reportPdfHtml(type, body, ctx) {
    let inner;
    switch (type) {
        case 'balance-sheet':
            inner = twoSide('Liabilities', body.liabilities || [], body.liab_total,
                            'Assets', body.assets || [], body.asset_total);
            break;
        case 'profit-loss':
            inner = twoSide('Expenses', body.left || [], body.left_total,
                            'Income', body.right || [], body.right_total);
            break;
        case 'gst-summary':
            inner = gstHtml(body);
            break;
        case 'trial-balance':
            inner = genericTable(body.data || [], body.totals);
            break;
        default:
            // sales-register / day-book / outstanding / ledger / stock-summary
            inner = genericTable(body.data || body.rows || [], body.total != null ? { amount: body.total } : null);
    }
    const landscape = type === 'sales-register' || type === 'day-book' || type === 'ledger';
    return { html: wrap(ctx, inner), landscape };
}

module.exports = { reportPdfHtml, inr };
