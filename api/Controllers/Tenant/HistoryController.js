'use strict';

/**
 * api/Controllers/Tenant/HistoryController.js
 *
 * Per-record CHANGE HISTORY API (the record_history table). Company-scoped by
 * req.companyId (resolveCompany); guarded by can('tally-sync','view') on the
 * read routes and can('tally-sync','edit') on revert — history hangs off the
 * Tally-Sync area, so it reuses those slugs rather than inventing a new one.
 *
 *   list(req,res)    — GET /history?module=&record_id=&page=&per_page=
 *     Paginated history rows for the company (optionally filtered to a module /
 *     record), newest first. Each row carries parsed before/after +
 *     changed_fields + a friendly one-line summary. Envelope: { data, meta }.
 *
 *   get(req,res)     — GET /history/:id
 *     One entry with the FULL parsed before/after objects (detail/compare view).
 *
 *   compare(req,res) — GET /history/compare?module=&record_id=
 *     The chronological snapshots for ONE record so the UI can show
 *     "value on date1 / date2 / today" side-by-side per field.
 *
 *   revert(req,res)  — POST /history/:id/revert
 *     Re-applies that entry's BEFORE snapshot to the LIVE cloud record (the row
 *     for the same company+record). If the record was deleted it is undeleted +
 *     restored. Immutable cols (id/company_id/created_at) are never written.
 *     Writes a NEW action:'reverted' history row. Reverts the CLOUD copy only —
 *     it re-syncs to Tally on the next agent cycle (said so in the msg).
 *
 * Conventions: every handler async + try/catch → console.error + 500 envelope;
 * the frozen {status,show,msg,data} envelope via Helpers/response.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { recordHistory } = require('../../Helpers/history');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

// Columns that must NEVER be written by a revert — identity / ownership /
// creation bookkeeping. (deleted_at is handled explicitly: revert clears it.)
const IMMUTABLE_COLS = new Set(['id', 'company_id', 'created_at']);

// history `module` slug → live table to revert into. Only modules that map to a
// single revertable row are listed; vouchers with line items (sales/purchase
// invoices) are header-revertable too (their items are not touched). A module
// not in this map is non-revertable (revert returns a clear 422).
const MODULE_TABLE = {
    customers:            'customers',
    suppliers:            'suppliers',
    products:             'products',
    categories:           'categories',
    locations:            'locations',
    'sales-persons':      'sales_persons',
    'customer-groups':    'customer_groups',
    'sales-invoices':     'invoices',
    'purchase-invoices':  'invoices',
    payments:             'payments',
    receipts:             'payments',
    journals:             'journals',
};

// Tables that carry a soft-delete column (so a revert can undelete).
const SOFT_DELETE_TABLES = new Set([
    'customers', 'suppliers', 'products', 'categories', 'locations',
    'sales_persons', 'customer_groups', 'invoices', 'payments', 'journals',
]);

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

/** Parse a stored JSON text column back to an object/array (null-safe). */
function parseJson(text) {
    if (text == null || text === '') return null;
    try { return JSON.parse(text); } catch { return null; }
}

/** A short, human label for a record from its before/after snapshot. */
function recordLabel(before, after) {
    const src = after || before || {};
    return src.name || src.voucher_no || src.invoice_no || src.payment_no
        || (src.id != null ? `#${src.id}` : '');
}

/**
 * Build a plain-language summary of a history row, e.g.
 *   "Created by sync"
 *   "Updated · gst_number, opening_balance changed"
 *   "Deleted"
 *   "Reverted to an earlier version"
 */
function summarise(row, before, after, changedFields) {
    const action = String(row.action || '');
    const source = String(row.source || '');
    const via = source === 'tally' ? ' by Tally sync'
        : source === 'agent' ? ' by the agent'
        : source === 'system' ? ' by the system' : '';
    const fields = Array.isArray(changedFields) ? changedFields : [];

    if (action === 'created')  return `Created${via}`;
    if (action === 'deleted')  return `Deleted${via}`;
    if (action === 'reverted') return 'Reverted to an earlier version';
    if (action === 'updated' || action === 'synced') {
        const verb = action === 'synced' ? 'Synced' : 'Updated';
        if (fields.length) {
            const shown = fields.slice(0, 4).join(', ');
            const more  = fields.length > 4 ? ` +${fields.length - 4} more` : '';
            return `${verb}${via} · ${shown}${more} changed`;
        }
        return `${verb}${via}`;
    }
    return `${action || 'Changed'}${via}`;
}

/** Shape one DB row into the API row (parsed JSON + summary + label). */
function shapeRow(row) {
    const before        = parseJson(row.before_json);
    const after         = parseJson(row.after_json);
    const changedFields = parseJson(row.changed_fields) || [];
    return {
        id:             row.id,
        module:         row.module || '',
        record_type:    row.record_type || '',
        record_id:      row.record_id != null ? row.record_id : null,
        record_label:   recordLabel(before, after),
        action:         row.action || '',
        source:         row.source || '',
        before,
        after,
        changed_fields: changedFields,
        changed_by:     row.changed_by != null ? row.changed_by : null,
        changed_by_name: row.changed_by_name || null,
        note:           row.note || '',
        summary:        summarise(row, before, after, changedFields),
        created_at:     row.created_at || null,
    };
}

async function list(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const moduleF = (req.query.module || '').trim();
        const actionF = (req.query.action || '').trim();
        const sourceF = (req.query.source || '').trim();
        const recordId = req.query.record_id != null && req.query.record_id !== ''
            ? Number(req.query.record_id) : null;
        const search = (req.query.search || '').trim();

        let qb = db('record_history as h')
            .leftJoin('users as u', 'u.id', 'h.changed_by')
            .where('h.company_id', req.companyId);

        if (moduleF) qb = qb.whereRaw('lower(h.module) = lower(?)', [moduleF]);
        if (actionF) qb = qb.whereRaw('lower(h.action) = lower(?)', [actionF]);
        if (sourceF) qb = qb.whereRaw('lower(h.source) = lower(?)', [sourceF]);
        if (Number.isInteger(recordId) && recordId > 0) qb = qb.where('h.record_id', recordId);
        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('h.module', 'ilike', like)
                 .orWhere('h.record_type', 'ilike', like)
                 .orWhere('h.note', 'ilike', like)
                 .orWhere('h.before_json', 'ilike', like)
                 .orWhere('h.after_json', 'ilike', like);
            });
        }

        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('h.id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('h.id', 'desc')
            .select(
                'h.id', 'h.module', 'h.record_type', 'h.record_id', 'h.action',
                'h.source', 'h.before_json', 'h.after_json', 'h.changed_fields',
                'h.changed_by', 'h.note', 'h.created_at', 'u.name as changed_by_name',
            );

        return R.successResponse(res, {
            data: rows.map(shapeRow),
            meta: { total, page, per_page: perPage },
        });
    } catch (err) {
        console.error('history.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function get(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, 'Invalid history id.', 422);

        const row = await db('record_history as h')
            .leftJoin('users as u', 'u.id', 'h.changed_by')
            .where('h.company_id', req.companyId)
            .where('h.id', id)
            .first(
                'h.id', 'h.module', 'h.record_type', 'h.record_id', 'h.action',
                'h.source', 'h.before_json', 'h.after_json', 'h.changed_fields',
                'h.changed_by', 'h.note', 'h.created_at', 'u.name as changed_by_name',
            );
        if (!row) return R.errorResponse(res, 'History entry not found.', 404);

        return R.successResponse(res, shapeRow(row));
    } catch (err) {
        console.error('history.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * compare(req,res) — GET /history/compare?module=&record_id=
 *
 * Returns the chronological snapshots for ONE record + the union of every field
 * that ever changed, so the web can render a per-field "value on each date"
 * grid. Shape:
 *   { data: {
 *       module, record_id, record_label,
 *       fields:     [field names, union across snapshots],
 *       snapshots:  [ { history_id, action, source, when, values:{field:val} } ],
 *   } }
 *
 * The `values` of each snapshot are taken from that row's AFTER (the state the
 * record was in right after that change). The earliest row's BEFORE is added as
 * an "original" snapshot when present so the very first state is visible too.
 */
async function compare(req, res) {
    try {
        const moduleF = (req.query.module || '').trim();
        const recordId = req.query.record_id != null && req.query.record_id !== ''
            ? Number(req.query.record_id) : null;
        if (!moduleF || !Number.isInteger(recordId) || recordId <= 0) {
            return R.errorResponse(res, 'module and record_id are required.', 422);
        }

        const rows = await db('record_history')
            .where('company_id', req.companyId)
            .whereRaw('lower(module) = lower(?)', [moduleF])
            .where('record_id', recordId)
            .orderBy('id', 'asc')
            .select('id', 'module', 'record_type', 'record_id', 'action', 'source',
                    'before_json', 'after_json', 'changed_fields', 'created_at');

        const snapshots = [];
        const fieldSet  = new Set();
        let label = '';

        // Seed with the earliest BEFORE (the record's original state) if present.
        if (rows.length) {
            const firstBefore = parseJson(rows[0].before_json);
            if (firstBefore && typeof firstBefore === 'object') {
                for (const k of Object.keys(firstBefore)) {
                    if (k !== 'updated_at' && k !== 'created_at') fieldSet.add(k);
                }
                snapshots.push({
                    history_id: null, action: 'original', source: rows[0].source || '',
                    when: rows[0].created_at || null, values: firstBefore,
                });
            }
        }

        for (const r of rows) {
            const after = parseJson(r.after_json);
            const before = parseJson(r.before_json);
            const values = after || before || {};
            if (values && typeof values === 'object') {
                for (const k of Object.keys(values)) {
                    if (k !== 'updated_at' && k !== 'created_at') fieldSet.add(k);
                }
            }
            if (!label) label = recordLabel(before, after);
            snapshots.push({
                history_id: r.id,
                action:     r.action || '',
                source:     r.source || '',
                when:       r.created_at || null,
                values:     values && typeof values === 'object' ? values : {},
            });
        }

        return R.successResponse(res, {
            module:       moduleF,
            record_id:    recordId,
            record_label: label,
            fields:       Array.from(fieldSet),
            snapshots,
        });
    } catch (err) {
        console.error('history.compare error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * revert(req,res) — POST /history/:id/revert   (user-auth, company-scoped)
 *
 * Re-applies the entry's BEFORE snapshot to the live cloud record. Company-
 * scoped: the history row AND the target record must belong to req.companyId,
 * so one tenant can never revert another's record. Cloud-side only — the change
 * re-syncs to Tally on the next agent cycle.
 */
async function revert(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, 'Invalid history id.', 422);

        const entry = await db('record_history')
            .where('company_id', req.companyId)
            .where('id', id)
            .first('id', 'module', 'record_type', 'record_id', 'action',
                   'before_json', 'after_json');
        if (!entry) return R.errorResponse(res, 'History entry not found.', 404);

        const before = parseJson(entry.before_json);
        if (!before || typeof before !== 'object') {
            return R.errorResponse(res,
                'This entry has no "before" snapshot to revert to (it was a create).', 422);
        }

        const table = MODULE_TABLE[entry.module];
        if (!table) {
            return R.errorResponse(res, `The "${entry.module}" module cannot be reverted.`, 422);
        }
        const recordId = entry.record_id != null ? Number(entry.record_id)
            : (before.id != null ? Number(before.id) : null);
        if (!Number.isInteger(recordId) || recordId <= 0) {
            return R.errorResponse(res, 'This entry is not tied to a single record id.', 422);
        }

        // The CURRENT live row (company-scoped). Soft-deleted rows are included
        // so a revert can undelete them. A row that belongs to another company
        // (or never existed) → 404.
        const liveRow = await db(table)
            .where('company_id', req.companyId)
            .where('id', recordId)
            .first();
        if (!liveRow) {
            return R.errorResponse(res, 'The record to revert no longer exists.', 404);
        }

        // Build the patch from the BEFORE snapshot, skipping immutable columns.
        const patch = {};
        for (const [k, v] of Object.entries(before)) {
            if (IMMUTABLE_COLS.has(k)) continue;
            if (k === 'deleted_at') continue;   // handled explicitly below
            patch[k] = v;
        }
        patch.updated_at = new Date();
        // Restore (undelete) when the snapshot represents a live record and the
        // table supports soft delete.
        if (SOFT_DELETE_TABLES.has(table)) patch.deleted_at = null;

        const [restored] = await db(table).where('id', recordId).update(patch).returning('*');

        // Write a NEW history row recording the revert (before = the live row we
        // replaced, after = the restored row). changed_by = the acting user.
        await recordHistory(db, {
            company_id:  req.companyId,
            module:      entry.module,
            record_type: entry.record_type || entry.module,
            record_id:   recordId,
            action:      'reverted',
            source:      'cloud',
            before:      liveRow,
            after:       restored,
            changed_by:  req.user ? req.user.sub : null,
            note:        `Reverted to history #${entry.id}`,
        });

        return R.successResponse(res, restored,
            'Record reverted to the earlier snapshot. This updated the CLOUD copy only — '
            + 'it will re-sync to Tally on the next agent cycle.');
    } catch (err) {
        console.error('history.revert error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list,
    get,
    compare,
    revert,
};
