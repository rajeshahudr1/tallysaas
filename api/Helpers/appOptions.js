'use strict';

/**
 * api/Helpers/appOptions.js
 *
 * THE single source of truth for the small "config enumerations" that drive
 * <select> dropdowns which are NOT backed by their own master table — supplier
 * groups, payment terms, customer groups, GST rates, units, the status
 * lifecycle, etc.
 *
 * Why this file exists:
 *   These lists used to live ONLY in the web BFF's `web/data/mock.js`, hardcoded
 *   per render. That meant the mobile app had no way to get them without
 *   re-hardcoding the same arrays — two copies that silently drift. Per the
 *   project rule ("nothing hardcoded on the app side; if the web hardcodes an
 *   option list, lift it to the API so web + app share one source") these are
 *   centralised here and served via `GET /config/options`. Web should migrate
 *   its `mock.*` reads to this endpoint so there is exactly ONE place to edit.
 *
 * These are global (not company-scoped) today. If a future requirement makes
 * any of them per-company configurable, move that key to a settings table and
 * have ConfigController merge the company override on top — the response
 * contract (a `{ key: [strings] }` map) stays the same.
 *
 * Keys are snake_case to match the request/response field style elsewhere.
 */

// Supplier classification buckets (Tally "groups" under Sundry Creditors).
const SUPPLIER_GROUPS = ['Raw Material', 'Packaging', 'Services', 'Transport'];

// Customer classification buckets.
const CUSTOMER_GROUPS = ['Retail', 'Wholesale', 'Distributor'];

// Credit/payment windows offered on supplier + purchase documents.
const PAYMENT_TERMS = ['On Delivery', '7 Days', '15 Days', '30 Days', '45 Days', '60 Days'];

// GST slabs (India). Strings carry the % so the UI renders them verbatim.
const GST_RATES = ['0%', '5%', '12%', '18%', '28%'];

// Stock units of measure.
const UNITS = ['Nos', 'Kg', 'Gram', 'Litre', 'Meter', 'Box', 'Dozen', 'Bag', 'Pack', 'Set'];

// Financial years (most-recent first). Kept static to mirror the previous web
// behaviour; can later be derived from the company's books open date.
const FINANCIAL_YEARS = ['2024-2025', '2023-2024', '2022-2023'];

// Payment / receipt voucher modes (free text server-side, but offered as a list).
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT/RTGS', 'Card'];

// Journal voucher kinds — matches Validators/journal.js VCH_TYPES.
const JOURNAL_VCH_TYPES = ['Journal', 'Contra', 'Credit Note', 'Debit Note'];

// The master-record status lifecycle the create/update validators accept.
const STATUSES = ['Active', 'Inactive', 'Blocked'];

/**
 * The full options map served by `GET /config/options`. A plain object of
 * `key → string[]`; the controller can return all of it or a requested subset.
 */
const OPTIONS = {
    supplier_groups:    SUPPLIER_GROUPS,
    customer_groups:    CUSTOMER_GROUPS,
    payment_terms:      PAYMENT_TERMS,
    payment_modes:      PAYMENT_MODES,
    journal_vch_types:  JOURNAL_VCH_TYPES,
    gst_rates:          GST_RATES,
    units:              UNITS,
    financial_years:    FINANCIAL_YEARS,
    statuses:           STATUSES,
};

module.exports = {
    OPTIONS,
    SUPPLIER_GROUPS,
    CUSTOMER_GROUPS,
    PAYMENT_TERMS,
    PAYMENT_MODES,
    JOURNAL_VCH_TYPES,
    GST_RATES,
    UNITS,
    FINANCIAL_YEARS,
    STATUSES,
};
