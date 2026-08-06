'use strict';

/**
 * api/Controllers/Public/PayController.js
 *
 * GET /pay/:token — the PUBLIC page a customer opens from a payment-request
 * link. No auth (the token IS the credential — 24 random bytes, see
 * CollectPaymentController.create). Returns only what a payer needs to see:
 * who to pay, how much, for what invoice, and a UPI deep link — never any
 * internal id, company financials, or anything beyond this one request.
 *
 * No payment gateway sits behind this: `upi_uri` is a plain `upi://pay?...`
 * link (Helpers/upiLink.js) that hands off straight to whatever UPI app the
 * payer has — the platform never sees or touches the money. `status` is
 * whatever a human last set it to (pending/paid/cancelled); it is NEVER
 * flipped by this endpoint being hit, however many times.
 *
 * TENANT LOOKUP: this app is database-PER-LICENSE (see config/tenantDb.js's
 * header comment) — `payment_requests` lives in each licence's own tenant
 * db. The token is `<licenseId>.<48 hex chars>` (see Tenant/
 * CollectPaymentController.create) precisely so this public, unauthenticated
 * route never has to fan a lookup out across every active licence's tenant
 * db — it parses the licence id straight off the token and queries only
 * that one db. A token that doesn't parse (no licence part, non-numeric,
 * or the licence doesn't exist) 404s immediately, before touching any
 * database — the cheapest possible response to a guessed/malformed token.
 * The licence id is not a secret and adds no guessability; all the
 * unguessability still lives in the random half.
 */

const R  = require('../../Helpers/response');
const tenantDb = require('../../config/tenantDb');
const { buildUpiUri } = require('../../Helpers/upiLink');
const throttle = require('../../Helpers/throttle');
const QRCode = require('qrcode');

const NOT_FOUND_MSG = 'Payment link not found.';

// token shape: "<licenseId>.<random>" — licenseId is digits only, random is
// whatever CollectPaymentController.create emits (currently 48 hex chars,
// but this parser does not pin the random part's exact length/alphabet so a
// future longer/differently-encoded random half still parses).
const TOKEN_RE = /^(\d+)\.([A-Za-z0-9]+)$/;

/**
 * Parse "<licenseId>.<random>" → { licenseId, random } or null. Pure string
 * work — never touches a database — so a malformed token 404s before any
 * query runs.
 */
function parseToken(token) {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const licenseId = Number(m[1]);
    if (!Number.isInteger(licenseId) || licenseId <= 0) return null;
    return { licenseId, random: m[2] };
}

// Guessing a 24-byte random token is already infeasible, but this endpoint
// is public and unauthenticated, so throttle it anyway — per Helpers/throttle.js,
// making the guess EXPENSIVE is the point (see the agent-login throttle for
// the same pattern). Per-IP, not per-token: an attacker probing many tokens
// from one host is what this defends against.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 60;

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '').split(',')[0].trim();
}

async function show(req, res) {
    try {
        const ip = clientIp(req);
        const verdict = throttle.hit(`pay:token:ip:${ip}`, MAX_PER_IP, WINDOW_MS);
        if (!verdict.allowed) {
            return R.errorResponse(res,
                `Too many requests. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s).`, 429);
        }

        const token = String(req.params.token || '').trim();
        if (!token) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        const parsed = parseToken(token);
        if (!parsed) return R.errorResponse(res, NOT_FOUND_MSG, 404);

        let db;
        let request;
        try {
            db = tenantDb.getKnexForLicense(parsed.licenseId);
            request = await db('payment_requests').where({ token }).whereNull('deleted_at').first();
        } catch (err) {
            // Licence id parsed but doesn't map to a real tenant db (e.g. a
            // pre-shape testing row, or a licence id that never existed) —
            // fail clean, same as "not found", never a 500.
            console.error('PayController.show tenant lookup error:', err.message);
            return R.errorResponse(res, NOT_FOUND_MSG, 404);
        }
        if (!request || request.status === 'cancelled') {
            return R.errorResponse(res, NOT_FOUND_MSG, 404);
        }

        const [company, invoice] = await Promise.all([
            db('companies').where('id', request.company_id).first('name'),
            db('invoices').where('id', request.invoice_id).first('invoice_no'),
        ]);

        const settingsRow = await db('settings')
            .where({ company_id: request.company_id, key: 'collect_payments' })
            .first('value');
        const settings = settingsRow ? settingsRow.value : null;

        const upiUri = (settings && settings.enabled)
            ? buildUpiUri({
                vpa:        settings.upi_vpa,
                payeeName:  settings.payee_name || (company && company.name) || '',
                amount:     request.amount,
                note:       invoice ? invoice.invoice_no : `Payment Request #${request.id}`,
            })
            : null;

        // qrcode is only a dependency of api/ (not web/) — this is why the QR is
        // generated here, server-side, and shipped as a ready PNG data-URI
        // rather than asking web/ to build one from the upi_uri. When there is
        // no UPI URI (company hasn't finished setup), the field is simply
        // omitted — never a broken <img>.
        let qrDataUri;
        if (upiUri) {
            try {
                qrDataUri = await QRCode.toDataURL(upiUri, { margin: 1, width: 240 });
            } catch (err) {
                // A QR that fails to render is not fatal — the page still has
                // the plain upi_uri link + VPA to fall back on.
                console.error('PayController.show QR generation error:', err.message);
            }
        }

        const payload = {
            company_name: (company && company.name) || '',
            invoice_no:   (invoice && invoice.invoice_no) || '',
            amount:       request.amount,
            status:       request.status,
            upi_uri:      upiUri,
        };
        if (qrDataUri) payload.qr_data_uri = qrDataUri;

        return R.successResponse(res, payload);
    } catch (err) {
        console.error('PayController.show error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { show, parseToken };
