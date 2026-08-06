'use strict';

/**
 * api/Helpers/upiLink.js
 *
 * Builds a `upi://pay?...` deep link — the BHIM/UPI standard "intent" URI any
 * UPI app on the payer's phone understands. This is NOT a payment gateway
 * integration: no account, no keys, no fees, no request ever leaves this
 * process. The money moves directly between the payer's bank and the VPA
 * (`pa`) below — the platform never touches or routes it, and this helper
 * must never be changed to imply otherwise.
 *
 * Pure function — no DB, no network, no I/O. Returns null (never throws) on
 * any malformed input, so a bad VPA/amount degrades to "no link" rather than
 * a broken deep link a UPI app can't parse.
 */

// Minimal VPA shape check: <handle>@<bank>, both sides non-empty, no
// whitespace. This is deliberately loose (real bank suffixes vary) — the
// goal is to reject obviously-wrong input, not to validate against a bank
// registry.
const VPA_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * @param {object} params
 * @param {string} params.vpa        payee's UPI id, e.g. "shop@okhdfcbank"
 * @param {string} params.payeeName  payee display name, e.g. "Shree Traders"
 * @param {number} params.amount     amount in rupees, must be > 0
 * @param {string} [params.note]     transaction note (e.g. invoice no)
 * @returns {string|null} the `upi://pay?...` URI, or null when refused
 */
function buildUpiUri({ vpa, payeeName, amount, note } = {}) {
    if (typeof vpa !== 'string' || !VPA_RE.test(vpa.trim())) return null;

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return null;

    const params = new URLSearchParams();
    params.set('pa', vpa.trim());
    params.set('pn', payeeName || '');
    params.set('am', amt.toFixed(2));
    params.set('cu', 'INR');
    if (note) params.set('tn', note);

    return `upi://pay?${params.toString()}`;
}

module.exports = { buildUpiUri };
