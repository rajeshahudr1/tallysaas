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
 * db, and a bare token carries no licence id. This public route has no JWT
 * (no db_name claim) to route by, so it fans the lookup out across every
 * active licence's tenant db and takes the one that matches. Token
 * collision across tenants is not a practical concern (24 random bytes),
 * and the fan-out is bounded by the (small, cached-pool) licence count —
 * the same trade every db-per-tenant SaaS with a public unauthenticated
 * link makes.
 */

const R  = require('../../Helpers/response');
const masterDb = require('../../config/masterDb').db;
const tenantDb = require('../../config/tenantDb');
const { buildUpiUri } = require('../../Helpers/upiLink');
const throttle = require('../../Helpers/throttle');

const NOT_FOUND_MSG = 'Payment link not found.';

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

        const licenses = await masterDb('licenses')
            .whereNull('deleted_at')
            .select('id');

        let db = null;
        let request = null;
        for (const lic of licenses) {
            const tk = tenantDb.getKnexForLicense(lic.id);
            // eslint-disable-next-line no-await-in-loop
            const row = await tk('payment_requests').where({ token }).whereNull('deleted_at').first();
            if (row) { db = tk; request = row; break; }
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

        return R.successResponse(res, {
            company_name: (company && company.name) || '',
            invoice_no:   (invoice && invoice.invoice_no) || '',
            amount:       request.amount,
            status:       request.status,
            upi_uri:      upiUri,
        });
    } catch (err) {
        console.error('PayController.show error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { show };
