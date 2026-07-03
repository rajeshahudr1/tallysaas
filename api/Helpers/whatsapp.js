'use strict';

/**
 * api/Helpers/whatsapp.js
 *
 * Thin WhatsApp Cloud API (Meta) sender — the WhatsApp sibling of mail.js.
 * Reads credentials from the API .env (never per-tenant):
 *   WHATSAPP_TOKEN     — permanent access token
 *   WHATSAPP_PHONE_ID  — the sender phone-number id
 *   WHATSAPP_API_URL   — Graph base (default https://graph.facebook.com/v21.0)
 *
 * When WHATSAPP_TOKEN is blank, messages are LOGGED to the console instead of
 * sent — so dev works without a live API (mirrors mail.js's console-only mode).
 */

const TOKEN    = (process.env.WHATSAPP_TOKEN || '').trim();
const PHONE_ID = (process.env.WHATSAPP_PHONE_ID || '').trim();
const API_URL  = (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0').trim();

/** True when a live WhatsApp API is configured (else console-only dev mode). */
function isConfigured() {
    return !!(TOKEN && PHONE_ID);
}

/** Send a plain-text WhatsApp message. `to` may include spaces / + / dashes —
 * we strip to digits (country code required). Returns the API body, or
 * { consoleOnly: true } in dev. Throws on a live API error. */
async function sendWhatsApp(to, message) {
    const phone = String(to || '').replace(/[^\d]/g, '');
    if (!phone) throw new Error('WhatsApp: recipient phone number is missing');

    if (!isConfigured()) {
        console.log(`\n[whatsapp:console] (WHATSAPP_TOKEN not set — not actually sent)\n  to: ${phone}\n  ${message}\n`);
        return { consoleOnly: true };
    }

    const res = await fetch(`${API_URL}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { preview_url: false, body: message },
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        throw new Error(`WhatsApp API error: ${msg}`);
    }
    return body;
}

/** Send a DOCUMENT (e.g. a PDF) by hosted link. WhatsApp Cloud API fetches the
 * `link` itself, so it must be publicly reachable. `caption` is optional text
 * shown with the file. Console-only in dev (no token). Throws on a live error. */
async function sendWhatsAppDocument(to, link, filename, caption) {
    const phone = String(to || '').replace(/[^\d]/g, '');
    if (!phone) throw new Error('WhatsApp: recipient phone number is missing');
    if (!link) throw new Error('WhatsApp: document link is missing');

    if (!isConfigured()) {
        console.log(`\n[whatsapp:console] (WHATSAPP_TOKEN not set — not actually sent)\n  to: ${phone}\n  document: ${filename} → ${link}\n  ${caption || ''}\n`);
        return { consoleOnly: true };
    }

    const res = await fetch(`${API_URL}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'document',
            document: { link, filename: filename || 'document.pdf', caption: caption || undefined },
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        throw new Error(`WhatsApp API error: ${msg}`);
    }
    return body;
}

module.exports = { sendWhatsApp, sendWhatsAppDocument, isConfigured };
