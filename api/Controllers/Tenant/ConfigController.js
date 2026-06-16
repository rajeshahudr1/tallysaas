'use strict';

/**
 * api/Controllers/Tenant/ConfigController.js
 *
 * GET /config/options — serves the small "config enumeration" lists (supplier
 * groups, payment terms, customer groups, GST rates, units, financial years,
 * statuses) that feed <select> dropdowns NOT backed by a master table.
 *
 * This is the API-side single source of truth (see Helpers/appOptions.js) so
 * the web BFF and the mobile app render the SAME choices without re-hardcoding
 * them. Returns the standard { data, meta } envelope; `data` is a map of
 * `key → [strings]`.
 *
 * Optional `?keys=supplier_groups,payment_terms` narrows the payload to just
 * the requested keys (unknown keys are ignored). With no `keys`, the whole map
 * is returned — handy for a form that needs several lists in one round-trip.
 *
 * Runs behind `authenticate` only — these are global, non-tenant enums, so no
 * resolveCompany / RBAC gate is needed.
 */

const R = require('../../Helpers/response');
const { OPTIONS } = require('../../Helpers/appOptions');

function options(req, res) {
    try {
        const raw = (req.query && typeof req.query.keys === 'string') ? req.query.keys : '';
        const wanted = raw
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);

        let data;
        if (wanted.length) {
            data = {};
            for (const key of wanted) {
                if (Object.prototype.hasOwnProperty.call(OPTIONS, key)) {
                    data[key] = OPTIONS[key];
                }
            }
        } else {
            data = OPTIONS;
        }

        const keyCount = Object.keys(data).length;
        return R.successResponse(res, data, 'success', {
            meta: { total: keyCount, page: 1, per_page: keyCount },
        });
    } catch (err) {
        console.error('ConfigController.options error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { options };
