'use strict';

/**
 * api/Helpers/emailLayout.js
 *
 * ONE branded shell for every email the product sends. Each sender in
 * Helpers/mail.js supplies only its body; the header (logo + slogan), the card,
 * the footer and all the table scaffolding live here — so a brand change is one
 * edit, not five, and no email can quietly drift out of the look.
 *
 * ── Why it is built the way it is ────────────────────────────────────────────
 *
 * TABLES, NOT DIVS. Outlook on Windows renders through Word, which ignores
 * max-width, border-radius and box-shadow on a <div> — the old templates used
 * all three, so on Outlook they collapsed into a full-bleed, square, shadowless
 * block. Nested tables with width attributes are the only layout every client
 * agrees on.
 *
 * THE LOGO IS ATTACHED, NOT LINKED. It rides along as a CID attachment
 * (`logoAttachment()`), so it renders even in the many clients that block
 * remote images by default — a header that is blank until the recipient clicks
 * "display images" is not a header. It also means no tracking-pixel-shaped
 * request to our server, and no dependency on WEB_URL being set correctly.
 * The asset (assets/email-logo.png, 420px wide ≈ 37 KB) is a downscaled
 * flattened copy of web/public/img/logo-full.png; regenerate it from that file
 * if the logo changes.
 *
 * NO GRADIENT BEHIND THE LOGO. The mark is a blue→green gradient itself and
 * the wordmark is deep navy; on the old gradient bar the navy went nearly
 * invisible. The logo now sits on white, which is also what the web header
 * does.
 *
 * INLINE STYLES ONLY. <style> blocks are stripped by Gmail's web client.
 */

const path  = require('node:path');
const BRAND = require('../config/brand');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'email-logo.png');
const LOGO_CID  = 'teloora-logo';

// Display width in CSS px. The file is 2× this so it stays sharp on hidpi.
const LOGO_W = 210;

const C = {
    ink:    '#17265E',                 // brand navy — headings
    body:   '#334155',                 // body copy: darker than the old #6b7280,
    muted:  '#64748B',                 // which failed contrast at 13.5px
    hair:   '#E6E9F0',
    panel:  '#F6F8FC',
    page:   '#EEF1F6',
};

/**
 * The attachment array that makes the header logo appear. Spread it into
 * sendMail: `attachments: [...emailLayout.logoAttachment(), ...pdfs]`.
 *
 * `cid` must match the <img src="cid:…"> the shell renders.
 */
function logoAttachment() {
    return [{ filename: 'teloora.png', path: LOGO_PATH, cid: LOGO_CID }];
}

/**
 * Wrap body HTML in the branded card.
 *
 * @param {object}  opts
 * @param {string}  opts.body       inner HTML (already escaped by the caller)
 * @param {string} [opts.title]     bold line under the logo, e.g. "Payment reminder"
 * @param {string} [opts.heading]   overrides the logo with plain text — used by
 *                                  mail sent AS a customer's business, where our
 *                                  branding would be wrong
 * @param {string} [opts.footer]    small print under the card
 * @param {number} [opts.width]     card width in px (default 520)
 */
function wrap({ body, title, heading, footer, width = 520 } = {}) {
    const head = heading
        ? `<div style="font:700 19px/1.3 Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink}">${heading}</div>`
        : `<img src="cid:${LOGO_CID}" width="${LOGO_W}" alt="${BRAND.name} — ${BRAND.tagline}"
                style="display:block;border:0;outline:none;text-decoration:none;width:${LOGO_W}px;max-width:100%;height:auto">`;

    const titleRow = title
        ? `<tr><td style="padding:0 32px 4px">
             <div style="font:700 19px/1.35 Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink}">${title}</div>
           </td></tr>`
        : '';

    const footRow = footer
        ? `<tr><td align="center" style="padding:18px 24px 0">
             <div style="font:400 11.5px/1.6 Segoe UI,Helvetica,Arial,sans-serif;color:${C.muted}">${footer}</div>
           </td></tr>`
        : '';

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${BRAND.name}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<!-- Preheader intentionally omitted: the first body line is already the summary. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}">
  <tr><td align="center" style="padding:28px 12px">

    <table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0"
           style="width:${width}px;max-width:100%;background:#ffffff;border:1px solid ${C.hair};border-radius:16px">

      <!-- header: logo on white, hairline under it -->
      <tr><td style="padding:26px 32px 20px;border-bottom:1px solid ${C.hair}">${head}</td></tr>

      <tr><td style="height:22px;line-height:22px;font-size:0">&nbsp;</td></tr>
      ${titleRow}
      <tr><td style="padding:0 32px 28px;font:400 14.5px/1.65 Segoe UI,Helvetica,Arial,sans-serif;color:${C.body}">
        ${body}
      </td></tr>
    </table>

    ${footRow ? `<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%">${footRow}</table>` : ''}

  </td></tr>
</table>
</body></html>`;
}

/**
 * The big monospaced code block used by both one-time-code emails.
 * Letter-spacing on a centred block shifts it right by one gap, so the padding
 * is deliberately asymmetric to put the digits back on the axis.
 */
function codeBlock(code) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px">
      <tr><td align="center" style="background:${C.panel};border:1px solid ${C.hair};border-radius:12px;padding:18px 12px 18px 22px">
        <span style="font:700 34px/1 Consolas,Menlo,'Courier New',monospace;letter-spacing:10px;color:${C.ink}">${code}</span>
      </td></tr></table>`;
}

/** A soft panel for key/value details (credentials, invoice totals). */
function panel(innerHtml) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 4px">
      <tr><td style="background:${C.panel};border:1px solid ${C.hair};border-radius:12px;padding:16px 18px;
                     font:400 14px/1.7 Segoe UI,Helvetica,Arial,sans-serif;color:${C.body}">${innerHtml}</td></tr>
    </table>`;
}

/**
 * A bulletproof-ish call-to-action button. Kept as a table so Outlook gives it
 * real padding; the gradient degrades to the solid brand blue there, which is
 * the correct fallback rather than a transparent rectangle.
 */
function button(label, href) {
    if (!href) return '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 2px">
      <tr><td align="center" bgcolor="${BRAND.colors.blue}"
              style="border-radius:10px;background:${BRAND.colors.blue};background-image:${BRAND.colors.gradient}">
        <a href="${href}" style="display:inline-block;padding:12px 26px;font:700 14.5px/1 Segoe UI,Helvetica,Arial,sans-serif;
                                 color:#ffffff;text-decoration:none;border-radius:10px">${label}</a>
      </td></tr></table>`;
}

/** A muted note line (the "if you didn't expect this…" copy). */
function note(text) {
    return `<div style="margin:18px 0 0;font:400 12.5px/1.6 Segoe UI,Helvetica,Arial,sans-serif;color:${C.muted}">${text}</div>`;
}

module.exports = { wrap, codeBlock, panel, button, note, logoAttachment, COLORS: C, LOGO_CID, LOGO_PATH };
