'use strict';

/**
 * api/Controllers/Tenant/SyncController.js
 *
 * Read-only Tally-sync dashboard endpoints. NOT wired through the crudController
 * factory — these are bespoke aggregate/reporting reads with no writes.
 *
 *   summary(req,res) — GET /sync/summary
 *     Resolves this company's license (companies.license_id → licenses) to report
 *     agent connectivity (last_seen_at within 5 minutes), then aggregates per-
 *     module sync counts plus a recent-activity feed. Shape:
 *       { summary, stats, modules, recent }
 *
 *   logs(req,res) — GET /sync/logs
 *     Paginated, filterable view over tally_sync_logs (?module ?status ?direction
 *     ?search), company-scoped. Envelope: { data, meta }.
 *
 * Conventions: company-scoped by req.companyId (resolveCompany); every handler
 * async + try/catch → console.error + 500 envelope. tally_sync_logs has no
 * deleted_at column, so no soft-delete filter is applied to it.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { friendlyReason } = require('../../Helpers/syncReason');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE     = 100;

// Notification bell window: rows are "recent" within this lookback.
const NOTIF_WINDOW_MS  = 24 * 60 * 60 * 1000;   // last 24h
const NOTIF_RECENT_MAX = 15;                    // newest rows in the dropdown

// An agent is "connected" if its license was seen within this window.
const CONNECTED_WINDOW_MS = 5 * 60 * 1000;

// Clamp/normalise pagination from the query string.
function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

// Coerce a knex count(...).first() result to a plain number.
function asCount(row) {
    return Number(row ? row.c : 0);
}

/**
 * Best-effort latest synced_at for a module label. tally_sync_logs.module is
 * matched case-insensitively (ILIKE) so 'Sales Invoices' style labels line up
 * with whatever the agent wrote. Returns null when no log row matches.
 */
async function lastSyncFor(companyId, moduleLabel) {
    try {
        const row = await db('tally_sync_logs')
            .where('company_id', companyId)
            .where('module', 'ilike', moduleLabel)
            .max('synced_at as m')
            .first();
        return row ? row.m : null;
    } catch {
        // last_sync is decorative — never let it sink the whole summary.
        return null;
    }
}

/**
 * Count helper for a guid-based module (customers / suppliers / products).
 * synced = tally_guid NOT NULL, pending = tally_guid NULL, failed = 0.
 */
async function guidModule(companyId, table, label) {
    const [totalRow, syncedRow] = await Promise.all([
        db(table).where('company_id', companyId).whereNull('deleted_at')
            .count('id as c').first(),
        db(table).where('company_id', companyId).whereNull('deleted_at')
            .whereNotNull('tally_guid').count('id as c').first(),
    ]);
    const total  = asCount(totalRow);
    const synced = asCount(syncedRow);
    return {
        module:  label,
        total,
        synced,
        pending: total - synced,
        failed:  0,
        last_sync: await lastSyncFor(companyId, label),
    };
}

/**
 * Count helper for a status-based voucher module (invoices/payments of a type).
 * synced = status 'created', pending = status IN (pending_tally,sent_to_tally),
 * failed = status 'failed'.
 */
async function statusModule(companyId, table, typeVal, label) {
    const base = () => db(table)
        .where('company_id', companyId)
        .whereNull('deleted_at')
        .where('type', typeVal);

    const [totalRow, syncedRow, pendingRow, failedRow] = await Promise.all([
        base().count('id as c').first(),
        base().where('status', 'created').count('id as c').first(),
        base().whereIn('status', ['pending_tally', 'sent_to_tally']).count('id as c').first(),
        base().where('status', 'failed').count('id as c').first(),
    ]);

    return {
        module:  label,
        total:   asCount(totalRow),
        synced:  asCount(syncedRow),
        pending: asCount(pendingRow),
        failed:  asCount(failedRow),
        last_sync: await lastSyncFor(companyId, label),
    };
}

async function summary(req, res) {
    try {
        const companyId = req.companyId;

        // ── License / agent connectivity ───────────────────────────────
        const company = await db('companies')
            .where('id', companyId)
            .first('id', 'name', 'license_id');

        let license = null;
        if (company && company.license_id) {
            license = await db('licenses')
                .where('id', company.license_id)
                .first('id', 'status', 'last_seen_at', 'agent_version', 'machine_id',
                       'last_open_companies');
        }

        const lastSeen  = license && license.last_seen_at ? new Date(license.last_seen_at) : null;
        const connected = !!(lastSeen && (Date.now() - lastSeen.getTime()) <= CONNECTED_WINDOW_MS);

        // The agent reports the Tally companies currently open via heartbeat
        // (stored JSON-encoded on the license). Parse it back to an array so the
        // web Sync page can show "Currently open in Tally: X, Y". Tolerate a
        // missing column / bad JSON by falling back to an empty list.
        let openCompanies = [];
        if (license && license.last_open_companies) {
            try {
                const parsed = JSON.parse(license.last_open_companies);
                if (Array.isArray(parsed)) {
                    openCompanies = parsed.map((n) => String(n == null ? '' : n).trim()).filter((n) => n);
                }
            } catch {
                openCompanies = [];
            }
        }

        const summaryBlock = {
            connected,
            status:        license && license.status ? license.status : 'unknown',
            agent_version: license ? (license.agent_version || null) : null,
            last_seen_at:  license ? (license.last_seen_at || null) : null,
            last_open_companies: openCompanies,
            company:       company ? (company.name || null) : null,
        };

        // ── Headline stats ─────────────────────────────────────────────
        const [
            totalSyncedRow,
            failedRow,
            custPendingRow,
            prodPendingRow,
            invPendingRow,
            payPendingRow,
        ] = await Promise.all([
            db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'synced').count('id as c').first(),
            db('tally_sync_logs').where('company_id', companyId)
                .where('status', 'failed').count('id as c').first(),
            db('customers').where('company_id', companyId).whereNull('deleted_at')
                .whereNull('tally_guid').count('id as c').first(),
            db('products').where('company_id', companyId).whereNull('deleted_at')
                .whereNull('tally_guid').count('id as c').first(),
            db('invoices').where('company_id', companyId).whereNull('deleted_at')
                .where('status', 'pending_tally').count('id as c').first(),
            db('payments').where('company_id', companyId).whereNull('deleted_at')
                .where('status', 'pending_tally').count('id as c').first(),
        ]);

        const stats = {
            total_synced: asCount(totalSyncedRow),
            pending: asCount(custPendingRow) + asCount(prodPendingRow) +
                     asCount(invPendingRow)  + asCount(payPendingRow),
            failed: asCount(failedRow),
        };

        // ── Per-module breakdown ───────────────────────────────────────
        const modules = await Promise.all([
            guidModule(companyId, 'customers', 'Customers'),
            guidModule(companyId, 'suppliers', 'Suppliers'),
            guidModule(companyId, 'products',  'Products'),
            statusModule(companyId, 'invoices', 'sales',    'Sales Invoices'),
            statusModule(companyId, 'invoices', 'purchase', 'Purchase Invoices'),
            statusModule(companyId, 'payments', 'payment',  'Payments'),
            statusModule(companyId, 'payments', 'receipt',  'Receipts'),
        ]);

        // ── Recent activity feed ───────────────────────────────────────
        const recent = await db('tally_sync_logs')
            .where('company_id', companyId)
            .orderBy('id', 'desc')
            .limit(6)
            .select('module', 'record_type', 'record_id', 'status', 'created_at');

        return R.successResponse(res, {
            summary: summaryBlock,
            stats,
            modules,
            recent,
        });
    } catch (err) {
        console.error('sync.summary error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function logs(req, res) {
    try {
        const { page, perPage } = parsePagination(req.query);
        const moduleF    = (req.query.module || '').trim();
        const statusF    = (req.query.status || '').trim();
        const directionF = (req.query.direction || '').trim();
        const search     = (req.query.search || '').trim();

        let qb = db('tally_sync_logs').where('company_id', req.companyId);

        if (moduleF)    qb = qb.where('module', moduleF);
        if (statusF)    qb = qb.where('status', statusF);
        if (directionF) qb = qb.where('direction', directionF);

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => {
                b.where('record_type', 'ilike', like)
                 .orWhere('message', 'ilike', like);
            });
        }

        // Count BEFORE pagination — clone so offset/limit/order don't leak in.
        const totalRow = await qb.clone().clearSelect().clearOrder()
            .count('id as c').first();
        const total = asCount(totalRow);

        const rows = await qb
            .offset((page - 1) * perPage)
            .limit(perPage)
            .orderBy('id', 'desc')
            .select(
                'module', 'record_type', 'record_id', 'direction',
                'status', 'message', 'created_at', 'synced_at',
            );

        return R.successResponse(res, {
            data: rows,
            meta: { total, page, per_page: perPage },
        });
    } catch (err) {
        console.error('sync.logs error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * notifications(req,res) — GET /sync/notifications
 *
 * Drives the web/app notification BELL straight from tally_sync_logs (company-
 * scoped). The "unread" count = failed rows in the last 24h (this is what the
 * badge shows). Shape:
 *   { data: {
 *       unread, fail_count, ok_count,
 *       last_sync_at,
 *       recent: [ {id, module, record_type, status, direction,
 *                  reason:{cause,fix,severity}, raw_message, when} ],
 *       failed_by_module: [ {module, n} ],
 *   } }
 *
 * `recent` is the 15 newest rows (id desc) decorated with friendlyReason() so
 * the bell shows a plain-language cause/fix on failures. The window math uses a
 * JS-side cutoff timestamp so it works regardless of DB clock formatting.
 */
async function notifications(req, res) {
    try {
        const companyId = req.companyId;
        const cutoff    = new Date(Date.now() - NOTIF_WINDOW_MS);

        const [
            unreadRow,
            okRow,
            lastRow,
            recent,
            failedByModule,
        ] = await Promise.all([
            // Unread badge = failed in the last 24h. FAILED rows are written with
            // synced_at = NULL (AgentController.result), so the 24h window MUST key
            // off created_at — filtering failed rows on synced_at would always be
            // false (NULL >= cutoff) and the badge would never move off 0.
            db('tally_sync_logs')
                .where('company_id', companyId)
                .where('status', 'failed')
                .where('created_at', '>=', cutoff)
                .count('id as c').first(),
            // OK = synced/created in the last 24h. These rows carry synced_at.
            db('tally_sync_logs')
                .where('company_id', companyId)
                .whereIn('status', ['synced', 'created'])
                .where('synced_at', '>=', cutoff)
                .count('id as c').first(),
            // Newest synced_at across all rows (last activity).
            db('tally_sync_logs')
                .where('company_id', companyId)
                .max('synced_at as m').first(),
            // The 15 newest rows for the dropdown feed. created_at is pulled too
            // so failed rows (synced_at = NULL) still carry a usable timestamp.
            db('tally_sync_logs')
                .where('company_id', companyId)
                .orderBy('id', 'desc')
                .limit(NOTIF_RECENT_MAX)
                .select('id', 'module', 'record_type', 'status', 'direction',
                        'message', 'synced_at', 'created_at'),
            // Per-module failure tally (all-time, company-scoped).
            db('tally_sync_logs')
                .where('company_id', companyId)
                .where('status', 'failed')
                .select('module')
                .count('id as n')
                .groupBy('module')
                .orderBy('n', 'desc'),
        ]);

        const recentOut = recent.map((r) => ({
            id:          r.id,
            module:      r.module || '',
            record_type: r.record_type || '',
            status:      r.status || '',
            direction:   r.direction || '',
            reason:      friendlyReason(r.message, r.status),
            raw_message: r.message || '',
            // synced_at is NULL on failed rows → fall back to created_at so the
            // bell can render a relative time for failures too.
            when:        r.synced_at || r.created_at || null,
        }));

        const failedOut = failedByModule.map((r) => ({
            module: r.module || '(unknown)',
            n:      Number(r.n) || 0,
        }));

        return R.successResponse(res, {
            unread:           asCount(unreadRow),
            fail_count:       asCount(unreadRow),
            ok_count:         asCount(okRow),
            last_sync_at:     lastRow ? (lastRow.m || null) : null,
            recent:           recentOut,
            failed_by_module: failedOut,
        });
    } catch (err) {
        console.error('sync.notifications error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    summary,
    logs,
    notifications,
};
