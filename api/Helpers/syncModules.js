'use strict';

/**
 * api/Helpers/syncModules.js
 *
 * The Tally-syncable MODULES the operator can pick for AUTO push (Cloud→Tally)
 * and AUTO pull (Tally→Cloud). When Auto-push/Auto-pull is ON, ONLY the selected
 * modules move; the rest are skipped. Stored per-licence as a JSON array in
 * licenses.sync_push_modules / .sync_pull_modules (text). NULL / empty column =
 * ALL modules (backward compatible — a licence that never configured this syncs
 * everything, exactly as before).
 *
 * The keys match the record-type families the agent handles in /pending (push)
 * and /import (pull). This ONE list is the single source of truth for the API
 * (filtering), the web + app (the checkbox popup) and the agent logs.
 */

const SYNC_MODULES = [
    { key: 'customers',         label: 'Customers' },
    { key: 'suppliers',         label: 'Suppliers' },
    { key: 'products',          label: 'Products' },
    { key: 'categories',        label: 'Categories' },
    { key: 'locations',         label: 'Locations' },
    { key: 'sales-invoices',    label: 'Sales Invoices' },
    { key: 'purchase-invoices', label: 'Purchase Invoices' },
    { key: 'payments',          label: 'Payments' },
    { key: 'receipts',          label: 'Receipts' },
    { key: 'journals',          label: 'Journals' },
];
const ALL_KEYS = SYNC_MODULES.map((m) => m.key);

/**
 * Parse the stored JSON-array text column into a clean key list. Returns:
 *   • null  → column null/empty/invalid → treat as ALL modules enabled.
 *   • [...] → the explicit (valid-only) selection ([] means NOTHING selected).
 */
function parseModules(raw) {
    if (raw == null || raw === '') return null;
    let arr;
    try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => String(x)).filter((x) => ALL_KEYS.includes(x));
}

/** Is `moduleKey` enabled for a parsed selection? A null selection = ALL. */
function isEnabled(selection, moduleKey) {
    if (selection == null) return true;
    return selection.includes(moduleKey);
}

/** Normalise an incoming UI array to a valid, stable-ordered key list for storage. */
function sanitize(arr) {
    if (!Array.isArray(arr)) return [];
    const want = arr.map((x) => String(x));
    return ALL_KEYS.filter((k) => want.includes(k));
}

/** The key list for storage/echo: the parsed selection, or ALL_KEYS when null. */
function effectiveKeys(raw) {
    const sel = parseModules(raw);
    return sel == null ? ALL_KEYS.slice() : sel;
}

module.exports = { SYNC_MODULES, ALL_KEYS, parseModules, isEnabled, sanitize, effectiveKeys };
