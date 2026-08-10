'use strict';

/**
 * web/config/options.js
 *
 * The few dropdown enumerations that are PURELY presentational — labels this
 * BFF renders in filter bars, which no API endpoint owns.
 *
 * Everything else a form needs (states, GST rates, units, payment modes,
 * groups, financial years, …) comes from the api's single source,
 * GET /config/options (api/Helpers/appOptions.js), via `fetchConfig` in
 * routes/web.js. Do NOT re-hardcode those here: two copies of the same list
 * drift, and the api's copy is the one the mobile app reads.
 *
 * REPLACES: data/mock.js. That was a 52 KB Phase-1 demo file holding both
 * these enumerations AND fake business records ("Amit Enterprises", "Rajesh
 * Kumar", "PAY-2024-0092"). It is gitignored, so `require('./data/mock')`
 * crashed the web server the moment it was deployed while working fine
 * locally. The fake records are gone — an empty filter dropdown is honest;
 * one listing customers who do not exist is not.
 */

/** Sales/purchase invoice Tally-sync state — a web-side filter label set. */
const INVOICE_STATUSES = ['Pending Tally', 'Sent to Tally', 'Created', 'Failed'];

/** Sync-log filter labels (the log rows themselves come from the api). */
const SYNC_MODULE_NAMES = [
    'Companies', 'Customers', 'Suppliers', 'Products',
    'Sales Invoices', 'Purchase Invoices', 'Payments', 'Receipts', 'Inventory',
];
const SYNC_DIRECTIONS   = ['Push', 'Pull'];
const SYNC_LOG_STATUSES = ['Synced', 'Pending', 'Failed'];

module.exports = {
    INVOICE_STATUSES,
    SYNC_MODULE_NAMES,
    SYNC_DIRECTIONS,
    SYNC_LOG_STATUSES,
};
