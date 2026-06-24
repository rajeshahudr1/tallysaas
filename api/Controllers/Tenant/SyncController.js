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
const agentRelease = require('../../Helpers/agentRelease');

const OOPS_MSG         = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE     = 100;

// Notification bell window: rows are "recent" within this lookback.
const NOTIF_WINDOW_MS  = 24 * 60 * 60 * 1000;   // last 24h
const NOTIF_RECENT_MAX = 100;                   // newest rows in the dropdown (scrolls; older via "View all")

// An agent is "connected" if its license was seen within this window. The agent
// heartbeats every 60s, so 150s = 2.5 missed beats before we call it down (snug
// enough for the dashboard poller to flip ~live, loose enough to not flap).
const CONNECTED_WINDOW_MS = 150 * 1000;

// The full module catalogue surfaced on the Sync Dashboard. `key` is a stable
// machine id (used by the per-module retry button + DOM ids); `label` is the
// human heading; `kind` picks the counting strategy; `table`/`type` locate the
// source rows. `logModules` are the record_type values the agent writes into
// tally_sync_logs.module for this module (used for the per-module failed tally
// + last_sync lookup). Keep this list as the SINGLE source of truth for both
// summary() and retry().
const MODULE_CATALOG = [
    { key: 'customers',         label: 'Customers',         kind: 'guid',    table: 'customers', logModules: ['customer'] },
    { key: 'suppliers',         label: 'Suppliers',         kind: 'guid',    table: 'suppliers', logModules: ['supplier'] },
    { key: 'products',          label: 'Products',          kind: 'guid',    table: 'products',  logModules: ['product'] },
    { key: 'categories',        label: 'Categories',        kind: 'cat',     table: 'categories', logModules: ['category'] },
    { key: 'locations',         label: 'Locations',         kind: 'guid',    table: 'locations', logModules: ['location'] },
    { key: 'sales_invoices',    label: 'Sales Invoices',    kind: 'voucher', table: 'invoices',  typeCol: 'type', typeVal: 'sales',    logModules: ['sales_invoice'] },
    { key: 'purchase_invoices', label: 'Purchase Invoices', kind: 'voucher', table: 'invoices',  typeCol: 'type', typeVal: 'purchase', logModules: ['purchase_invoice'] },
    { key: 'payments',          label: 'Payments',          kind: 'voucher', table: 'payments',  typeCol: 'type', typeVal: 'payment',  logModules: ['payment'] },
    { key: 'receipts',          label: 'Receipts',          kind: 'voucher', table: 'payments',  typeCol: 'type', typeVal: 'receipt',  logModules: ['receipt'] },
    { key: 'journals',          label: 'Journals',          kind: 'voucher', table: 'journals',  logModules: ['journal'] },
];

// Fast lookup by key for retry().
const MODULE_BY_KEY = MODULE_CATALOG.reduce((acc, m) => { acc[m.key] = m; return acc; }, {});

// ── Notification feed (record_history → bell + /notifications) ──────────────
// Window for cloud-side user actions surfaced as notifications.
const NOTIF_ACTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // last 30 days
const NOTIF_PAGE_MAX         = 300;                        // cap for the full page

// record_history.module (singular log name OR plural key) → { label, path } so a
// notification can show a friendly title AND deep-link to the right list page.
const NOTIF_MODULE_META = {};
MODULE_CATALOG.forEach((m) => {
    const hyphen = m.key.replace(/_/g, '-');               // sales_invoices → sales-invoices
    const meta   = { label: m.label, path: '/' + hyphen };
    NOTIF_MODULE_META[m.key]  = meta;                       // 'sales_invoices'
    NOTIF_MODULE_META[hyphen] = meta;                       // 'sales-invoices' (the value history stores)
    (m.logModules || []).forEach((lm) => { NOTIF_MODULE_META[lm] = meta; });
});
// crudController + transaction controllers write these exact (plural, hyphenated)
// module slugs; map the ones not derivable from MODULE_CATALOG above.
Object.assign(NOTIF_MODULE_META, {
    'sales-persons':   { label: 'Sales Persons',   path: '/sales-persons' },
    'customer-groups': { label: 'Customer Groups', path: '/customers' },
    company:   { label: 'Company', path: '/companies' }, companies: { label: 'Company', path: '/companies' },
    user:      { label: 'User',    path: '/users' },     users:     { label: 'User',    path: '/users' },
    stock_adjustment: { label: 'Stock', path: '/inventory' }, inventory: { label: 'Stock', path: '/inventory' },
});
function notifModuleMeta(module) {
    return NOTIF_MODULE_META[String(module || '').toLowerCase()] || { label: 'Record', path: '/' };
}
// action verb → { verb, tone, icon } for the notification presentation.
function notifAction(action) {
    switch (String(action || '').toLowerCase()) {
        case 'created':  return { verb: 'created',  tone: 'success', icon: 'fa-circle-plus' };
        case 'updated':  return { verb: 'updated',  tone: 'primary', icon: 'fa-pen' };
        case 'deleted':  return { verb: 'deleted',  tone: 'danger',  icon: 'fa-trash-can' };
        case 'synced':   return { verb: 'synced',   tone: 'info',    icon: 'fa-rotate' };
        case 'reverted': return { verb: 'reverted', tone: 'warning', icon: 'fa-rotate-left' };
        default:         return { verb: String(action || 'changed'), tone: 'muted', icon: 'fa-circle-info' };
    }
}
// Pull a human display name out of a history before/after JSON snapshot so the
// notification reads "ABC Traders" / "INV-001" instead of a bare id.
function notifRecordName(jsonText) {
    if (!jsonText) return '';
    try {
        const o = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
        if (!o || typeof o !== 'object') return '';
        return String(o.name || o.title || o.invoice_no || o.voucher_no
            || o.holder_name || o.sku || o.email || '').trim();
    } catch (_) { return ''; }
}
// Map one record_history row → a uniform notification item. key = 'h<id>'.
function historyToNotif(r, readSet) {
    const a    = notifAction(r.action);
    const meta = notifModuleMeta(r.module);
    const key  = 'h' + r.id;
    const name = notifRecordName(r.action === 'deleted' ? r.before_json : r.after_json);
    return {
        id:    key,
        kind:  'action',
        tone:  a.tone,
        icon:  a.icon,
        title: `${meta.label} ${a.verb}`,
        sub:   name || r.note || (r.record_type && r.record_type !== r.module ? String(r.record_type) : ''),
        link:  meta.path,
        when:  r.created_at,
        read:  readSet.has(key),
    };
}
// Recent CLOUD user-actions (create/update/delete/revert) as notification items.
// SOURCE='cloud' only — the per-record bulk-sync rows (source tally/agent) stay in
// the full Change-History audit and never flood the bell. PER company.
async function buildActionFeed(companyId, readSet, limit) {
    try {
        const cutoff = new Date(Date.now() - NOTIF_ACTION_WINDOW_MS);
        const rows = await db('record_history')
            .where('company_id', companyId)
            .where('source', 'cloud')
            .where('created_at', '>=', cutoff)
            .orderBy('id', 'desc')
            .limit(limit)
            .select('id', 'module', 'record_type', 'record_id', 'action', 'note',
                    'before_json', 'after_json', 'created_at');
        return rows.map((r) => historyToNotif(r, readSet));
    } catch (err) {
        console.error('sync.notifications buildActionFeed (ignored):', err && err.message);
        return [];
    }
}
// The UNREAD cloud-action keys (for the badge + markAllRead). Cheap id-only scan.
async function unreadActionKeys(companyId, readSet) {
    try {
        const cutoff = new Date(Date.now() - NOTIF_ACTION_WINDOW_MS);
        const rows = await db('record_history')
            .where('company_id', companyId).where('source', 'cloud')
            .where('created_at', '>=', cutoff).select('id');
        const keys = [];
        for (const r of rows) { const k = 'h' + r.id; if (!readSet.has(k)) keys.push(k); }
        return keys;
    } catch (err) {
        console.error('sync.notifications unreadActionKeys (ignored):', err && err.message);
        return [];
    }
}
// A failed sync-log row → uniform notification item (links to the Sync Logs page).
function failedLogToNotif(r, readSet) {
    const reason = friendlyReason(r.message, r.status);
    const rec = [r.module, r.record_type].filter(Boolean).join(' ');
    return {
        id:    String(r.id),
        kind:  'failed',
        tone:  'danger',
        icon:  'fa-triangle-exclamation',
        title: `Sync failed${rec ? ': ' + rec : ''}`,
        sub:   (reason && reason.cause) ? reason.cause : (r.message || 'A sync attempt failed.'),
        link:  '/sync-logs',
        when:  r.synced_at || r.created_at || null,
        read:  readSet.has(String(r.id)),
    };
}

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

// Parse a version string ("1.10.0") to a numeric tuple for comparison. Mirrors
// the agent's _version_tuple so the server-side "newer" decision matches the
// agent's (1.10.0 > 1.9.9). Non-numeric segments collapse to 0.
function versionTuple(v) {
    return String(v == null ? '' : v).trim().split('.').map((n) => {
        const x = parseInt(n, 10);
        return Number.isFinite(x) ? x : 0;
    });
}

// True when `latest` is strictly newer than `installed` (semantic tuple
// compare). Empty/null inputs → false (nothing to update). Shared by summary().
function isNewer(latest, installed) {
    const a = versionTuple(latest);
    const b = versionTuple(installed);
    if (!a.length || !String(latest || '').trim()) return false;
    if (!b.length || !String(installed || '').trim()) {
        // No installed version known → treat a published latest as available.
        return !!String(latest || '').trim();
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;   // equal → not newer
}

/**
 * Best-effort latest synced_at across a set of tally_sync_logs.module values
 * (the agent writes record_type-style module names). Returns a full ISO string
 * (or null) so the web can format BOTH date AND time. Never throws — last_sync
 * is decorative and must not sink the whole summary.
 */
async function lastSyncForModules(companyId, logModules) {
    try {
        const row = await db('tally_sync_logs')
            .where('company_id', companyId)
            .whereIn('module', logModules)
            .max('synced_at as m')
            .first();
        const v = row ? row.m : null;
        return v ? new Date(v).toISOString() : null;
    } catch {
        return null;
    }
}

/**
 * Recent failed-row count for a module from tally_sync_logs (company-scoped).
 * Vouchers ALSO carry a failed status on their own table, but masters never do
 * (a master that fails to push just stays tally_guid NULL = pending), so the
 * log is the single, uniform source of "failed" across every module kind.
 */
async function failedLogCount(companyId, logModules) {
    try {
        const row = await db('tally_sync_logs')
            .where('company_id', companyId)
            .where('status', 'failed')
            .whereIn('module', logModules)
            .count('id as c').first();
        return asCount(row);
    } catch {
        return 0;
    }
}

/**
 * Compute one module's {key,label,total,synced,pending,failed,last_sync_at}
 * from the real source tables (company-scoped, deleted_at NULL). Counting
 * strategy by kind:
 *   guid    — masters: synced = tally_guid NOT NULL, pending = tally_guid NULL
 *   cat     — categories have no tally_guid (always re-pushed, idempotent) →
 *             treat all as synced, pending = 0
 *   voucher — synced = status 'created' OR tally_voucher_no set,
 *             pending = status IN (pending_tally,sent_to_tally),
 *             failed   = status 'failed' (table) — the higher of this and the
 *             recent failed-log tally is shown.
 */
async function moduleStats(companyId, spec) {
    const failedLogs = await failedLogCount(companyId, spec.logModules);
    const last_sync_at = await lastSyncForModules(companyId, spec.logModules);

    if (spec.kind === 'guid') {
        const [totalRow, syncedRow] = await Promise.all([
            db(spec.table).where('company_id', companyId).whereNull('deleted_at')
                .count('id as c').first(),
            db(spec.table).where('company_id', companyId).whereNull('deleted_at')
                .whereNotNull('tally_guid').count('id as c').first(),
        ]);
        const total  = asCount(totalRow);
        const synced = asCount(syncedRow);
        return {
            key: spec.key, label: spec.label,
            total, synced, pending: total - synced, failed: failedLogs, last_sync_at,
        };
    }

    if (spec.kind === 'cat') {
        const totalRow = await db(spec.table).where('company_id', companyId)
            .whereNull('deleted_at').count('id as c').first();
        const total = asCount(totalRow);
        // No tally_guid column → categories re-push every cycle (idempotent in
        // Tally); count them all as synced so the bar never sits at 0% forever.
        return {
            key: spec.key, label: spec.label,
            total, synced: total, pending: 0, failed: failedLogs, last_sync_at,
        };
    }

    // voucher
    const base = () => {
        let q = db(spec.table).where('company_id', companyId).whereNull('deleted_at');
        if (spec.typeCol) q = q.where(spec.typeCol, spec.typeVal);
        return q;
    };
    const [totalRow, syncedRow, pendingRow, failedRow] = await Promise.all([
        base().count('id as c').first(),
        base().where(function () {
            this.where('status', 'created').orWhereNotNull('tally_voucher_no');
        }).count('id as c').first(),
        base().whereIn('status', ['pending_tally', 'sent_to_tally']).count('id as c').first(),
        base().where('status', 'failed').count('id as c').first(),
    ]);
    return {
        key: spec.key, label: spec.label,
        total:   asCount(totalRow),
        synced:  asCount(syncedRow),
        pending: asCount(pendingRow),
        failed:  Math.max(asCount(failedRow), failedLogs),
        last_sync_at,
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
                       'last_open_companies', 'auto_update',
                       'sync_push_enabled', 'sync_pull_enabled', 'sync_enabled');
        }

        // ── LIVE connectivity ── computed fresh from licenses.last_seen_at on
        // every call (the agent heartbeats every 60s). 'connected' iff the last
        // beat is within CONNECTED_WINDOW_MS — so the dashboard poller can flip
        // the badge green/grey without a page reload.
        const lastSeen  = license && license.last_seen_at ? new Date(license.last_seen_at) : null;
        const connected = !!(lastSeen && (Date.now() - lastSeen.getTime()) <= CONNECTED_WINDOW_MS);

        // Newest synced_at across ALL of this company's log rows = the headline
        // "Last Sync" (full ISO so the web renders date AND time).
        let lastSyncAt = null;
        try {
            const lr = await db('tally_sync_logs').where('company_id', companyId)
                .max('synced_at as m').first();
            lastSyncAt = lr && lr.m ? new Date(lr.m).toISOString() : null;
        } catch { lastSyncAt = null; }

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

        // ── Auto-update / release info (Requirement 3) ── the published-latest
        // exe (the single is_current agent_releases row, fallback env), whether
        // the agent's installed version is older than it (server-side semver
        // compare), and the per-LICENSE cloud auto-update toggle. All best-effort:
        // a release-table hiccup must never sink the whole summary.
        const installedVersion = license ? (license.agent_version || null) : null;
        let latestVersion = null;
        let mandatory = false;
        let releaseNotes = null;
        try {
            const rel = await agentRelease.currentRelease(db);
            if (rel && rel.version) {
                latestVersion = rel.version;
                mandatory = !!rel.mandatory;
                releaseNotes = rel.notes || null;
            }
        } catch { latestVersion = null; }
        if (!latestVersion) {
            latestVersion = (String(process.env.AGENT_LATEST_VERSION || '').trim() || null);
        }
        const updateAvailable = isNewer(latestVersion, installedVersion);
        // Default ON when the column is missing/unreadable (matches /agent/version).
        const autoUpdate = license && license.auto_update != null ? !!license.auto_update : true;

        // Per-license AUTO-sync toggles. These gate ONLY the agent's automatic
        // loop (the heartbeat echoes the EFFECTIVE flags); the dashboard's MANUAL
        // per-module buttons are independent of them. We return the RAW values
        // here (NOT the effective push&&sync_enabled the heartbeat sends) so the
        // read-only Settings/Dashboard UI shows exactly what each switch is set
        // to. Default ON when the column is missing/unreadable, so existing
        // licenses (and a pre-migration DB) read as all-ON with no regression.
        //   • sync_enabled — the MASTER "Auto-sync" switch (migration 0041).
        //   • push_enabled / pull_enabled — the per-direction auto toggles.
        const syncEnabled = license && license.sync_enabled      != null ? !!license.sync_enabled      : true;
        const pushEnabled = license && license.sync_push_enabled != null ? !!license.sync_push_enabled : true;
        const pullEnabled = license && license.sync_pull_enabled != null ? !!license.sync_pull_enabled : true;

        const heartbeatIso = lastSeen ? lastSeen.toISOString() : null;
        const summaryBlock = {
            connected,
            // 'connected' | 'disconnected' — the LIVE connection state (kept
            // alongside the existing boolean so consumers can read either).
            connection:    connected ? 'connected' : 'disconnected',
            status:        license && license.status ? license.status : 'unknown',
            agent_version: installedVersion,
            last_seen_at:  license ? (license.last_seen_at || null) : null,
            // Full ISO timestamps the web formats to date+time.
            heartbeat_at:  heartbeatIso,
            last_sync_at:  lastSyncAt,
            last_open_companies: openCompanies,
            company:       company ? (company.name || null) : null,
            // Auto-update surface for the Sync Dashboard (Requirement 3).
            latest_version:   latestVersion,
            update_available: updateAvailable,
            mandatory_update: mandatory,
            release_notes:    releaseNotes,
            auto_update:      autoUpdate,
            // Auto-sync toggles (RAW values for the read-only UI). The master
            // sync_enabled gates everything; push/pull are the per-direction
            // auto toggles. The agent loop honours the EFFECTIVE combination
            // (sync_enabled && direction) via the heartbeat, not these raw flags.
            sync_enabled:     syncEnabled,
            push_enabled:     pushEnabled,
            pull_enabled:     pullEnabled,
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

        // ── Per-module breakdown ── one entry per catalogued module, each
        // {key,label,total,synced,pending,failed,last_sync_at}. `module` +
        // `last_sync` aliases are kept so the existing web consumer (which reads
        // m.module / m.last_sync) keeps working while it migrates to the new keys.
        const moduleStatsList = await Promise.all(
            MODULE_CATALOG.map((spec) => moduleStats(companyId, spec)),
        );
        const modules = moduleStatsList.map((m) => ({
            ...m,
            module:    m.label,          // back-compat alias
            last_sync: m.last_sync_at,   // back-compat alias
        }));

        // ── Recent activity feed ───────────────────────────────────────
        const recent = await db('tally_sync_logs')
            .where('company_id', companyId)
            .orderBy('id', 'desc')
            .limit(6)
            .select('module', 'record_type', 'record_id', 'status', 'message', 'created_at');

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

        // Case-insensitive: the UI filter values are capitalised ("Failed",
        // "Pull") but the rows store lower-case ("failed", "pull").
        if (moduleF)    qb = qb.whereRaw('lower(module) = lower(?)', [moduleF]);
        if (statusF)    qb = qb.whereRaw('lower(status) = lower(?)', [statusF]);
        if (directionF) qb = qb.whereRaw('lower(direction) = lower(?)', [directionF]);

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
                'id', 'module', 'record_type', 'record_id', 'direction',
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
 * Build the "new agent version available" bell entry for a company, or null.
 *
 * Resolves the company's license (companies.license_id → licenses) for the
 * installed agent_version, reads the published-current release, and compares
 * with the SAME isNewer() semver helper summary() uses. When the latest is
 * strictly newer than installed, returns ONE notification object shaped like
 * the tally_sync_logs bell items (module/record_type/status/reason/raw_message/
 * when) so the existing dropdown renders it, PLUS the richer
 * { type, title, body, severity, created_at } fields. Especially relevant when
 * auto_update is OFF (auto agents update silently), but safe for all with an
 * update available. Best-effort: any error → null (the feed is never sunk).
 */
async function buildAgentUpdateNotif(companyId) {
    try {
        const company = await db('companies').where('id', companyId).first('id', 'license_id');
        if (!company || !company.license_id) return null;

        const license = await db('licenses')
            .where('id', company.license_id)
            .first('id', 'agent_version', 'auto_update');
        const installedVersion = license ? (license.agent_version || null) : null;

        let rel = null;
        try { rel = await agentRelease.currentRelease(db); } catch { rel = null; }
        let latestVersion = rel && rel.version ? rel.version : null;
        if (!latestVersion) {
            latestVersion = (String(process.env.AGENT_LATEST_VERSION || '').trim() || null);
        }
        if (!isNewer(latestVersion, installedVersion)) return null;

        const mandatory = !!(rel && rel.mandatory);
        const notes = rel && rel.notes ? String(rel.notes) : null;
        const createdAt = (rel && rel.created_at) || null;
        const autoUpdate = license && license.auto_update != null ? !!license.auto_update : true;

        const title = `New agent version v${latestVersion} available`;
        const body = notes
            || (autoUpdate
                ? 'The agent will update automatically on its next check.'
                : 'Auto-update is off — update the agent to get the latest fixes.');

        // Shaped BOTH as a bell item (so the existing dropdown renders it) AND
        // with the richer agent_update fields. A synthetic, stable id keyed off
        // the version so it's distinguishable from real log rows.
        return {
            id:          `agent-update-${latestVersion}`,
            type:        'agent_update',
            module:      'Agent Update',
            record_type: `v${latestVersion}`,
            // Not a sync row → keep it out of the "failed" red treatment.
            status:      'info',
            direction:   '',
            severity:    mandatory ? 'warning' : 'info',
            mandatory:   mandatory,
            title:       title,
            body:        body,
            // reason/raw_message mirror the sync-item shape so the dropdown's
            // sub-text logic has something to read.
            reason:      { cause: body, fix: '', severity: mandatory ? 'warning' : 'info' },
            raw_message: body,
            created_at:  createdAt,
            when:        createdAt,
        };
    } catch (err) {
        console.error('sync.notifications agent-update build (ignored):', err && err.message);
        return null;
    }
}

/**
 * The set of notification keys the given user has already marked read. Returns a
 * Set<string> of notification_key values (the bell item id as TEXT). Best-effort:
 * a read-table hiccup must never sink the feed — an empty Set just renders the
 * pre-read-tracking behaviour (everything unread). PER USER (user_id = sub).
 */
async function readKeySet(userId) {
    try {
        if (userId == null) return new Set();
        const rows = await db('notification_reads')
            .where('user_id', userId)
            .select('notification_key');
        return new Set(rows.map((r) => String(r.notification_key)));
    } catch (err) {
        console.error('sync.notifications readKeySet (ignored):', err && err.message);
        return new Set();
    }
}

/**
 * The CURRENTLY-UNREAD notification keys for a user (as TEXT) — the SINGLE source
 * of truth for both the badge count (its length) and markAllRead (the keys to
 * bulk-insert). Computed from:
 *   • each failed tally_sync_logs row in the 24h window whose id (stringified)
 *     is NOT in `readSet`, PLUS
 *   • the "agent-update-<version>" key when an update is available AND not read.
 * Takes the ALREADY-LOADED `readSet` + `updateNotif` so callers that built them
 * don't re-query / re-build (no N+1, no duplicate buildAgentUpdateNotif). One
 * cheap id-only window query for the failed candidates.
 */
async function computeUnreadKeys(companyId, readSet, updateNotif) {
    const cutoff = new Date(Date.now() - NOTIF_WINDOW_MS);

    // Candidate failed-in-window log ids (just the id — cheap), minus read ones.
    const failedRows = await db('tally_sync_logs')
        .where('company_id', companyId)
        .where('status', 'failed')
        .where('created_at', '>=', cutoff)
        .select('id');
    const keys = [];
    for (const r of failedRows) {
        const key = String(r.id);
        if (!readSet.has(key)) keys.push(key);
    }

    // The synthetic agent-update entry (one, keyed by version) when unread.
    if (updateNotif) {
        const key = String(updateNotif.id);
        if (!readSet.has(key)) keys.push(key);
    }

    // Cloud user-actions (create/update/delete across every module) not yet read.
    const actionKeys = await unreadActionKeys(companyId, readSet);
    for (const k of actionKeys) keys.push(k);

    return keys;
}

/**
 * notifications(req,res) — GET /sync/notifications
 *
 * Drives the web/app notification BELL straight from tally_sync_logs (company-
 * scoped) MINUS this user's already-read items (notification_reads, PER USER).
 * The "unread" count = failed rows in the last 24h NOT yet read by this user
 * (+1 for an unread agent-update entry). Each recent[] item carries `read`.
 * Shape:
 *   { data: {
 *       unread, fail_count, ok_count,
 *       last_sync_at,
 *       recent: [ {id, module, record_type, status, direction,
 *                  reason:{cause,fix,severity}, raw_message, when, read} ],
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
        const userId    = req.user && req.user.sub;
        const cutoff    = new Date(Date.now() - NOTIF_WINDOW_MS);

        // This user's already-read item keys (PER USER). recent[] items get a
        // `read` flag from this; the badge subtracts them from the unread count.
        const readSet = await readKeySet(userId);

        const [
            failRow,
            okRow,
            lastRow,
            recent,
            failedByModule,
        ] = await Promise.all([
            // Total failed in the last 24h (fail_count surface — NOT the badge;
            // the badge is the read-aware `unread` recomputed below). FAILED rows
            // are written with synced_at = NULL (AgentController.result), so the
            // 24h window MUST key off created_at — filtering failed rows on
            // synced_at would always be false (NULL >= cutoff).
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

        // ── UNIFIED notification feed ──────────────────────────────────────
        // Cloud user-actions (EVERY module: create/update/delete) + sync
        // FAILURES + the agent-update entry — newest first. Each item is uniform
        // { id, kind, tone, icon, title, sub, link, when, read } so the bell AND
        // the /notifications page render it identically and a click deep-links to
        // the right screen + marks it read.
        const actionItems = await buildActionFeed(companyId, readSet, NOTIF_RECENT_MAX);
        const failedItems = recent
            .filter((r) => String(r.status || '').toLowerCase() === 'failed')
            .map((r) => failedLogToNotif(r, readSet));
        const recentOut = actionItems.concat(failedItems)
            .sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0))
            .slice(0, NOTIF_RECENT_MAX);

        const failedOut = failedByModule.map((r) => ({
            module: r.module || '(unknown)',
            n:      Number(r.n) || 0,
        }));

        // ── New-agent-version notification — pinned to the TOP when present.
        // Auto-update=OFF agents need the operator to update; the bell is how
        // they find out. Best-effort: a lookup hiccup never sinks the feed.
        const updateNotif = await buildAgentUpdateNotif(companyId);
        if (updateNotif) {
            recentOut.unshift({
                id:    String(updateNotif.id),
                kind:  'update',
                tone:  String(updateNotif.severity || '') === 'warning' ? 'warning' : 'primary',
                icon:  'fa-cloud-arrow-down',
                title: updateNotif.title || 'New agent version available',
                sub:   updateNotif.body || '',
                link:  '/sync-dashboard',
                when:  updateNotif.when || new Date(),
                read:  readSet.has(String(updateNotif.id)),
            });
        }

        // ── Read-aware badge ── the unread count EXCLUDES this user's already-
        // read items: failed-in-window rows not yet read + (1 if an unread
        // agent-update entry exists). This is what persists across reload — the
        // server subtracts read items so the re-rendered badge is correct.
        const unread = (await computeUnreadKeys(companyId, readSet, updateNotif)).length;

        return R.successResponse(res, {
            // Read-aware unread badge (failed-in-window not yet read by this user
            // + an unread agent-update entry).
            unread:           unread,
            fail_count:       asCount(failRow),
            ok_count:         asCount(okRow),
            last_sync_at:     lastRow ? (lastRow.m || null) : null,
            recent:           recentOut,
            failed_by_module: failedOut,
            update_available: !!updateNotif,
        });
    } catch (err) {
        console.error('sync.notifications error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * Recompute the read-aware unread badge count for a user, FRESH from the DB.
 * Loads this user's read set + the agent-update entry, then counts the currently-
 * unread keys. Shared by markRead()/markAllRead() so they return the SAME count
 * the next GET /sync/notifications would render. PER USER + company-scoped.
 */
async function freshUnreadCount(companyId, userId) {
    const readSet = await readKeySet(userId);
    const updateNotif = await buildAgentUpdateNotif(companyId);
    const keys = await computeUnreadKeys(companyId, readSet, updateNotif);
    return keys.length;
}

/**
 * Idempotently mark a set of notification keys read for a user. Inserts one
 * (user_id, notification_key, read_at) row per key, ON CONFLICT
 * (user_id, notification_key) DO NOTHING — so re-marking the same key is a no-op
 * (the count can never over-drop). No-op on an empty list. Best-effort dedup of
 * the input keys. Uses Postgres' ON CONFLICT DO NOTHING via knex
 * .onConflict([...]).ignore().
 */
async function insertReads(userId, keys) {
    const uniq = Array.from(new Set(keys.map((k) => String(k)).filter((k) => k)));
    if (!uniq.length) return 0;
    const now = new Date();
    const rows = uniq.map((k) => ({ user_id: userId, notification_key: k, read_at: now }));
    await db('notification_reads')
        .insert(rows)
        .onConflict(['user_id', 'notification_key'])
        .ignore();
    return uniq.length;
}

/**
 * markRead(req,res) — POST /sync/notifications/read   (user-auth, company-scoped)
 * Body: { key } OR { keys: [...] } — the notification key(s) to mark read for
 * THIS user (req.user.sub). A key is the bell item id as text: a tally_sync_logs
 * id stringified OR "agent-update-<version>". Idempotent (ON CONFLICT DO NOTHING)
 * so clicking the same notification twice never over-counts. Returns the FRESH
 * read-aware { unread } so the client can set the live badge. 422 if no key.
 */
async function markRead(req, res) {
    try {
        const companyId = req.companyId;
        const userId    = req.user && req.user.sub;
        if (userId == null) return R.errorResponse(res, 'Not authenticated.', 401);

        const b = req.body || {};
        let keys = [];
        if (Array.isArray(b.keys)) keys = b.keys;
        else if (b.key != null) keys = [b.key];
        keys = keys.map((k) => String(k == null ? '' : k).trim()).filter((k) => k);

        if (!keys.length) return R.errorResponse(res, 'A notification key is required.', 422);

        await insertReads(userId, keys);

        const unread = await freshUnreadCount(companyId, userId);
        return R.successResponse(res, { unread });
    } catch (err) {
        console.error('sync.markRead error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * markAllRead(req,res) — POST /sync/notifications/read-all  (user-auth, scoped)
 *
 * Marks EVERY currently-unread item read for THIS user: computes the live unread
 * keys (failed-in-window log ids not yet read + the agent-update key if unread)
 * and bulk-inserts them ON CONFLICT DO NOTHING. After this the read-aware unread
 * count is 0, so we return { unread: 0 }. Idempotent.
 */
async function markAllRead(req, res) {
    try {
        const companyId = req.companyId;
        const userId    = req.user && req.user.sub;
        if (userId == null) return R.errorResponse(res, 'Not authenticated.', 401);

        const readSet = await readKeySet(userId);
        const updateNotif = await buildAgentUpdateNotif(companyId);
        const keys = await computeUnreadKeys(companyId, readSet, updateNotif);

        await insertReads(userId, keys);

        return R.successResponse(res, { unread: 0 });
    } catch (err) {
        console.error('sync.markAllRead error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * Parse a human RECORD NAME out of a log message. Pull rows carry
 * "Imported from Tally: X" → "X". Otherwise fall back to record_type + id so the
 * UI always has something to show. Shared by logDetail() and (mirrored) by the
 * web logs list.
 */
function recordNameFrom(message, recordType, recordId) {
    const raw = String(message == null ? '' : message);
    const m = raw.match(/imported from tally:\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
    const rt = String(recordType || '').trim();
    const rid = recordId != null ? String(recordId) : '';
    if (rt && rid) return `${rt} #${rid}`;
    return rt || (rid ? `#${rid}` : '');
}

/**
 * retry(req,res) — POST /sync/retry   (user-auth, company-scoped)
 * Body: { module? }  — a MODULE_CATALOG key; omitted = all modules.
 *
 * Re-queues this company's FAILED push records so the agent re-pushes them next
 * cycle. Idempotent + safe:
 *   • vouchers (invoices/payments/journals) — flip status 'failed' →
 *     'pending_tally' (the agent's /pending selects exactly that). Only failed
 *     rows are touched; created/pending rows are left alone.
 *   • masters (customers/suppliers/products/locations) — a failed push already
 *     left tally_guid NULL, so they're ALREADY re-queued every cycle. Nothing to
 *     reset (we count the still-pending = tally_guid NULL ones as "re-queued").
 *   • categories — always re-push (no guid column); reported as 0 reset.
 * Returns { requeued, modules:[{key,requeued}] }.
 */
async function retry(req, res) {
    try {
        // direction=pull → re-import this module FROM Tally (reset the pull
        // watermark). Default 'push' keeps the original re-queue behaviour.
        // The pull path is a separate, idempotent handler (see pull()).
        const direction = (req.body && req.body.direction
            ? String(req.body.direction).trim().toLowerCase() : 'push');
        if (direction === 'pull') {
            return pull(req, res);
        }

        const companyId = req.companyId;
        const wantKey = (req.body && req.body.module ? String(req.body.module).trim() : '');
        let specs = MODULE_CATALOG;
        if (wantKey) {
            const spec = MODULE_BY_KEY[wantKey];
            if (!spec) return R.errorResponse(res, 'Unknown module.', 422);
            specs = [spec];
        }

        const now = new Date();
        let requeued = 0;
        const perModule = [];

        for (const spec of specs) {
            let n = 0;
            if (spec.kind === 'voucher') {
                // Reset only FAILED vouchers back to pending_tally (idempotent —
                // re-running when nothing is failed updates 0 rows).
                let q = db(spec.table)
                    .where('company_id', companyId).whereNull('deleted_at')
                    .where('status', 'failed');
                if (spec.typeCol) q = q.where(spec.typeCol, spec.typeVal);
                n = await q.update({ status: 'pending_tally', updated_at: now });
            } else if (spec.kind === 'guid') {
                // Masters with tally_guid NULL are already re-queued by /pending;
                // report how many are still pending (informational, no write).
                const row = await db(spec.table)
                    .where('company_id', companyId).whereNull('deleted_at')
                    .whereNull('tally_guid').count('id as c').first();
                n = asCount(row);
            } else {
                // categories — re-push every cycle; nothing to reset.
                n = 0;
            }
            requeued += n;
            perModule.push({ key: spec.key, requeued: n });
        }

        return R.successResponse(res, { requeued, modules: perModule },
            requeued ? `Re-queued ${requeued} record(s) for sync.`
                     : 'Nothing to retry — everything is already queued or synced.');
    } catch (err) {
        console.error('sync.retry error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * pull(req,res) — POST /sync/pull  (also POST /sync/retry { direction:'pull' })
 * Body: { module? }  — a MODULE_CATALOG key; omitted = all modules.
 *
 * MANUAL "Sync from Tally" (Tally → cloud) for one module (or all). The agent's
 * PULL pass reads ALL of Tally but is gated by the per-company tally_sync_state
 * ALTERID WATERMARK (master_alter_id / voucher_alter_id), so an already-imported
 * master is skipped next cycle. To force a fresh re-import we RESET the relevant
 * watermark to 0 + null last_pull_at, so the agent's next _pull_pass re-reads
 * everything from Tally. (The pull dedupes masters by name and vouchers by
 * content, so a re-pull updates/links existing rows rather than duplicating.)
 *
 * Reset strategy:
 *   • a master module (guid/cat: customers/suppliers/products/categories/
 *     locations) → reset master_alter_id = 0
 *   • a voucher module (sales/purchase invoices, payments, receipts, journals)
 *     → reset voucher_alter_id = 0 (and master_alter_id too is harmless; we
 *     reset BOTH for a voucher module to be safe since the day-book pull also
 *     touches party masters)
 *   • all modules (no module key) → reset BOTH to 0
 * last_pull_at is always nulled so the next pull is treated as a first pull.
 *
 * MANUAL + independent of sync_pull_enabled: a user clicking "Sync from Tally"
 * works even when AUTO pull is OFF — it is an explicit action. (The watermark
 * reset takes effect on the NEXT agent pull pass; if AUTO pull is off the user
 * is expected to run a manual/once pull or re-enable it — the reset itself is
 * always honoured.) We ALSO enqueue a lightweight 'pull_now' agent_commands row
 * (best-effort) so the import happens promptly. Company-scoped + idempotent.
 * Returns { reset:true, module, fields:{...} }.
 */
async function pull(req, res) {
    try {
        const companyId = req.companyId;
        const wantKey = (req.body && req.body.module ? String(req.body.module).trim() : '');

        let spec = null;
        if (wantKey) {
            spec = MODULE_BY_KEY[wantKey];
            if (!spec) return R.errorResponse(res, 'Unknown module.', 422);
        }

        const now = new Date();

        // Decide which watermark column(s) to reset. The master watermark is
        // ALWAYS reset (the day-book pull touches party masters too, and only
        // master_alter_id actually gates the pull today); the voucher watermark
        // is reset for a voucher module or when no module is given. No module =
        // reset both. last_pull_at is always nulled (treat next pull as a first).
        const isVoucher = spec ? spec.kind === 'voucher' : true;
        const resetVoucher = !spec || isVoucher;

        // Ensure a state row exists, then reset the chosen watermark(s). Doing it
        // in one UPSERT-ish path keeps it idempotent (re-clicking just re-zeros).
        const existing = await db('tally_sync_state').where('company_id', companyId).first('id');
        const patch = { master_alter_id: 0, last_pull_at: null, updated_at: now };
        if (resetVoucher) patch.voucher_alter_id = 0;

        if (existing) {
            await db('tally_sync_state').where('company_id', companyId).update(patch);
        } else {
            await db('tally_sync_state').insert({
                company_id: companyId,
                master_alter_id: 0,
                voucher_alter_id: 0,
                last_pull_at: null,
                created_at: now,
                updated_at: now,
            });
        }

        // Best-effort: nudge the agent to pull promptly via the command channel.
        // The agent currently honours open_company/self_update; a 'pull_now' row
        // is harmless if unhandled (the agent fail-reports unknown types) and the
        // watermark reset already guarantees the next pull re-imports. Scoped to
        // THIS company's license. Never let a command-insert failure sink the
        // reset (the reset is the load-bearing part).
        try {
            const company = await db('companies').where('id', companyId)
                .whereNull('deleted_at').first('id', 'name', 'license_id');
            if (company && company.license_id) {
                await db('agent_commands').insert({
                    license_id: company.license_id,
                    company_id: company.id,
                    type: 'pull_now',
                    payload: JSON.stringify({
                        company_name: company.name,
                        module: wantKey || null,
                    }),
                    status: 'pending',
                    created_by: (req.user && req.user.sub) || null,
                    created_at: now,
                    updated_at: now,
                });
            }
        } catch (e) {
            // Command channel is a convenience; the watermark reset is enough.
            console.error('sync.pull enqueue (ignored):', e && e.message);
        }

        return R.successResponse(res, {
            reset: true,
            module: wantKey || null,
            fields: {
                master_alter_id: 0,
                voucher_alter_id: resetVoucher ? 0 : undefined,
                last_pull_at: null,
            },
        }, wantKey
            ? `Queued a fresh import of ${spec.label} from Tally. The agent will re-read it from Tally on its next pull.`
            : 'Queued a fresh import of all modules from Tally. The agent will re-read everything from Tally on its next pull.',
        { show: true });
    } catch (err) {
        console.error('sync.pull error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * logDetail(req,res) — GET /sync/logs/:id   (user-auth, company-scoped)
 *
 * The full single log row for the detail popup: module, record (type+id+name),
 * direction, status + friendlyReason, message, BOTH timestamps, and the raw
 * request_xml + response_xml. Company-scoped so a log id from another tenant
 * 404s. Envelope: { data: <row> }.
 */
async function logDetail(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return R.errorResponse(res, 'Invalid log id.', 422);
        }
        const row = await db('tally_sync_logs')
            .where('company_id', req.companyId)
            .where('id', id)
            .first('id', 'module', 'record_type', 'record_id', 'direction',
                   'status', 'message', 'request_xml', 'response_xml',
                   'retry_count', 'created_at', 'synced_at');
        if (!row) return R.errorResponse(res, 'Log not found.', 404);

        return R.successResponse(res, {
            id:           row.id,
            module:       row.module || '',
            record_type:  row.record_type || '',
            record_id:    row.record_id != null ? row.record_id : null,
            record_name:  recordNameFrom(row.message, row.record_type, row.record_id),
            direction:    row.direction || '',
            status:       row.status || '',
            reason:       friendlyReason(row.message, row.status),
            message:      row.message || '',
            request_xml:  row.request_xml || '',
            response_xml: row.response_xml || '',
            retry_count:  row.retry_count != null ? row.retry_count : 0,
            created_at:   row.created_at || null,
            synced_at:    row.synced_at || null,
        });
    } catch (err) {
        console.error('sync.logDetail error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * notificationsAll(req,res) — GET /sync/notifications/all  (paginated full feed)
 *
 * The same uniform notification items as the bell, but the WHOLE list (last 30
 * days) paginated — backs the dedicated /notifications page (View all + details
 * + Mark all read). Shape: { data:[{id,kind,tone,icon,title,sub,link,when,read}],
 * meta:{ total, page, per_page, unread } }. Company-scoped + PER-USER read flags.
 */
async function notificationsAll(req, res) {
    try {
        const companyId = req.companyId;
        const userId    = req.user && req.user.sub;
        let page    = parseInt(req.query.page, 10);     if (!(page > 0)) page = 1;
        let perPage = parseInt(req.query.per_page, 10); if (!(perPage > 0)) perPage = 20;
        if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;

        const readSet = await readKeySet(userId);

        const actionItems = await buildActionFeed(companyId, readSet, NOTIF_PAGE_MAX);

        const cutoff = new Date(Date.now() - NOTIF_ACTION_WINDOW_MS);
        const failedRows = await db('tally_sync_logs')
            .where('company_id', companyId).where('status', 'failed')
            .where('created_at', '>=', cutoff)
            .orderBy('id', 'desc').limit(NOTIF_PAGE_MAX)
            .select('id', 'module', 'record_type', 'status', 'message', 'synced_at', 'created_at');
        const failedItems = failedRows.map((r) => failedLogToNotif(r, readSet));

        const merged = actionItems.concat(failedItems)
            .sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));

        const updateNotif = await buildAgentUpdateNotif(companyId);
        if (updateNotif) {
            merged.unshift({
                id:   String(updateNotif.id), kind: 'update',
                tone: String(updateNotif.severity || '') === 'warning' ? 'warning' : 'primary',
                icon: 'fa-cloud-arrow-down', title: updateNotif.title || 'New agent version available',
                sub:  updateNotif.body || '', link: '/sync-dashboard',
                when: updateNotif.when || new Date(), read: readSet.has(String(updateNotif.id)),
            });
        }

        const total  = merged.length;
        const start  = (page - 1) * perPage;
        const data   = merged.slice(start, start + perPage);
        const unread = merged.filter((n) => !n.read).length;

        return R.successResponse(res, { data, meta: { total, page, per_page: perPage, unread } });
    } catch (err) {
        console.error('sync.notificationsAll error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    summary,
    logs,
    notifications,
    notificationsAll,
    markRead,
    markAllRead,
    retry,
    pull,
    logDetail,
};
