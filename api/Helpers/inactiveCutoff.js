'use strict';

/**
 * api/Helpers/inactiveCutoff.js
 *
 * Shared by the ?inactive=<days> list filters on customers and products, and
 * kept out of the controllers so both parse the parameter identically.
 */

const MAX_DAYS = 3650;   // ten years — anything larger is a typo, not a query.

/**
 * Parse a ?inactive=<days> value into a 'YYYY-MM-DD' cutoff date.
 * @returns {string|null} null when the value is not a positive integer in range.
 */
function cutoffFromDays(v) {
    const s = String(v == null ? '' : v).trim();
    if (!/^\d+$/.test(s)) return null;
    const days = Number(s);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return null;
    const d = new Date();
    d.setDate(d.getDate() - days);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { cutoffFromDays, MAX_DAYS };
