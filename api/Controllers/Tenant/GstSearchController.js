'use strict';

/**
 * api/Controllers/Tenant/GstSearchController.js
 *
 * GET /gst/verify?gstin=<15 chars> — decodes a GSTIN offline (state, PAN,
 * entity number — all derivable from the GSTIN's own characters, see
 * Helpers/gstin.js) and separately reports whether a live GSTIN LOOKUP
 * service (legal name, trade name, address, registration status) is
 * configured.
 *
 * No such service is wired up in this plan. `lookupProvider()` is the ONE
 * place that decision lives — when a real provider is added later, only
 * this function changes; the controller and the response shape stay the
 * same. Until then it always reports `{ available: false, reason:
 * 'not_configured' }` — never invented/stubbed data.
 */

const R = require('../../Helpers/response');
const { decodeGstin } = require('../../Helpers/gstin');

/**
 * The single seam for a future GSTIN lookup provider (legal name, trade
 * name, address, registration status). Checks settings/env for a
 * configured provider; today none exists, so it always reports
 * `not_configured`. Swap this function's body — not its shape, not its
 * callers — when a real provider is integrated. It must NEVER leak
 * provider keys/internals into its return value.
 */
async function lookupProvider(gstin) {
    const configured = !!(process.env.GST_LOOKUP_PROVIDER_URL && process.env.GST_LOOKUP_PROVIDER_KEY);
    if (!configured) {
        return { available: false, reason: 'not_configured' };
    }
    // A real provider integration would call out here and normalise its
    // response into { available: true, ... } — intentionally not
    // implemented in this plan.
    return { available: false, reason: 'not_configured' };
}

async function verify(req, res) {
    try {
        const gstin = String(req.query.gstin || '').trim().toUpperCase();
        const decoded = decodeGstin(gstin);
        const lookup = await lookupProvider(gstin);
        return R.successResponse(res, { valid: !!decoded, decoded, lookup });
    } catch (err) {
        console.error('GstSearchController.verify error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { verify };
