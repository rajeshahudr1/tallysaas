'use strict';

/**
 * api/Helpers/history.js
 *
 * recordHistory() — the single, reusable capture point for per-record change
 * HISTORY (the record_history table, migration 20260101000035).
 *
 * It is the HEART of the feature: it diffs a `before` snapshot against an
 * `after` snapshot, records the JSON of each plus the list of fields that
 * actually changed, and writes ONE history row. Called from:
 *   • crudController (create / update / remove) — source:'cloud'
 *   • AgentController.importFromTally (master upsert + voucher create) —
 *     source:'tally'
 *   • HistoryController.revert — action:'reverted', source:'cloud'
 *
 * Design rules (per the spec):
 *   • BEST-EFFORT — a history failure must NEVER break the CRUD op or the sync.
 *     Every write is wrapped in try/catch; on error we log and return null.
 *   • before/after are stored as JSON TEXT (JSON.stringify), so the row never
 *     depends on the source table's schema.
 *   • SKIP a no-op: when action==='updated' and nothing actually changed
 *     (diff is empty), no row is written (no history spam).
 *   • The diff is SHALLOW and ignores volatile bookkeeping columns
 *     (updated_at / created_at) so a touch of updated_at alone isn't "a change".
 *
 * Signature:
 *   recordHistory(executor, {
 *     company_id, module, record_type, record_id,
 *     action, source, before, after, changed_by, note,
 *   })
 * `executor` is a knex instance OR an open transaction — pass the SAME db/trx
 * the surrounding write uses so the history row shares its connection.
 */

const db = require('../config/db').db;

// Columns excluded from the before/after diff — pure bookkeeping that should
// not, on its own, count as "a change".
const IGNORED_FIELDS = new Set(['updated_at', 'created_at']);

/**
 * Loosely compare two scalar values for diff purposes. Dates and numbers are
 * normalised to strings so `5` vs `'5'` and a Date vs its ISO string don't read
 * as spurious changes. Objects/arrays fall back to JSON compare.
 */
function sameValue(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;

    if (a instanceof Date || b instanceof Date) {
        const da = a instanceof Date ? a.getTime() : new Date(a).getTime();
        const db2 = b instanceof Date ? b.getTime() : new Date(b).getTime();
        if (!Number.isNaN(da) && !Number.isNaN(db2)) return da === db2;
    }

    if (typeof a === 'object' || typeof b === 'object') {
        try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
    }

    // Scalar: compare as strings so 5 === '5' and 12.50 === '12.5' read equal.
    const sa = String(a);
    const sb = String(b);
    if (sa === sb) return true;
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
    return false;
}

/**
 * Shallow diff → array of field names whose value differs between before and
 * after (ignoring IGNORED_FIELDS). On a create (before null) every key in
 * `after` is "changed"; on a delete (after null) every key in `before` is.
 */
function diffFields(before, after) {
    const b = before && typeof before === 'object' ? before : null;
    const a = after && typeof after === 'object' ? after : null;
    const keys = new Set();
    if (b) for (const k of Object.keys(b)) keys.add(k);
    if (a) for (const k of Object.keys(a)) keys.add(k);

    const changed = [];
    for (const k of keys) {
        if (IGNORED_FIELDS.has(k)) continue;
        const bv = b ? b[k] : undefined;
        const av = a ? a[k] : undefined;
        if (!sameValue(bv, av)) changed.push(k);
    }
    return changed;
}

/** Safe JSON.stringify — returns null for null/undefined, swallows cycles. */
function toJsonText(v) {
    if (v === null || v === undefined) return null;
    try { return JSON.stringify(v); } catch { return null; }
}

/**
 * Capture one history row. Best-effort: returns the inserted id (or null) and
 * never throws.
 *
 * @param {import('knex').Knex|import('knex').Knex.Transaction} executor
 * @param {object} entry
 * @returns {Promise<number|null>}
 */
async function recordHistory(executor, entry) {
    const exec = executor || db;
    try {
        const {
            company_id,
            module,
            record_type,
            record_id,
            action,
            source = 'cloud',
            before = null,
            after = null,
            changed_by = null,
            note = null,
        } = entry || {};

        if (!company_id || !module || !action) {
            // Missing the essentials — skip silently (best-effort).
            return null;
        }

        const changed = diffFields(before, after);

        // No-op update → write nothing.
        if (action === 'updated' && changed.length === 0) return null;

        const row = {
            company_id,
            module: String(module),
            record_type: record_type != null ? String(record_type) : String(module),
            record_id: record_id != null ? record_id : null,
            action: String(action),
            source: String(source),
            before_json: toJsonText(before),
            after_json: toJsonText(after),
            changed_fields: toJsonText(changed),
            changed_by: changed_by != null ? Number(changed_by) || null : null,
            note: note != null ? String(note).slice(0, 255) : null,
            created_at: new Date(),
        };

        const [inserted] = await exec('record_history').insert(row).returning('id');
        return inserted && (inserted.id || inserted) || null;
    } catch (err) {
        // NEVER let a history failure break the surrounding write.
        console.error('recordHistory error:', err && err.message ? err.message : err);
        return null;
    }
}

module.exports = {
    recordHistory,
    diffFields,
    IGNORED_FIELDS,
};
