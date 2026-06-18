'use strict';

/**
 * api/Controllers/Agent/AgentController.js
 *
 * Endpoints the local Python sync agent calls. NO user auth — the agent
 * proves itself with the secret license key (activate) and then an agent
 * token (heartbeat/sync).
 *
 *   activate  — POST /api/v1/agent/activate   (public; presents the license key)
 *   heartbeat — POST /api/v1/agent/heartbeat  (authenticateAgent; req.license)
 *
 * Security:
 *   • The key is verified by sha256 hash (we never store it in clear).
 *   • First activation BINDS the license to the caller's machine fingerprint;
 *     a different machine is rejected (a copied key is useless elsewhere).
 *   • The returned agent token carries NO entitlement — every later call
 *     re-checks the license (status/expiry/machine) server-side, so a license
 *     can be suspended instantly and nothing is trusted from the client.
 */

const fs         = require('node:fs');
const path       = require('node:path');
const R          = require('../../Helpers/response');
const jwt        = require('../../Helpers/jwt');
const licenseKey = require('../../Helpers/licenseKey');
const db         = require('../../config/db').db;
const { recordHistory } = require('../../Helpers/history');
const agentRelease      = require('../../Helpers/agentRelease');

// ── Toggleable agent diagnostics ────────────────────────────────
// AGENT_DEBUG=1 in the api .env logs exactly WHAT each agent sent and WHAT the
// cloud did with it (received counts vs accepted/skipped). Pairs with the
// agent's own log_level=DEBUG so a "Tally had data but the cloud stored
// nothing" gap is visible from BOTH ends. Turn OFF (AGENT_DEBUG=0) after testing.
const AGENT_DEBUG = process.env.AGENT_DEBUG === '1';
function adbg(...args) {
    if (AGENT_DEBUG) { try { console.log('[AGENT_DEBUG]', new Date().toISOString(), ...args); } catch (_) { /* never break a request on a log */ } }
}

const AGENT_TOKEN_TTL = '7d';
const INVALID_KEY_MSG = 'Invalid license key.';

/**
 * Company SYNC gating (on-the-fly, NO stored flag): a license may sync only its
 * FIRST `max_companies` companies, ordered by created_at asc (id asc as a
 * tie-break), non-deleted. Companies beyond the cap do NOT sync (they're
 * excluded from the pull/push queue, the activate list and the command targets).
 * A null/absent max_companies → unlimited (no cap applied). The cap auto-adjusts
 * whenever max_companies changes — there is nothing to migrate.
 *
 * Returns the ordered, capped company rows for the license (the columns asked
 * for). `maxCompanies` is read from the license row; pass it through so callers
 * that already hold it avoid a second read.
 */
async function syncingCompanies(licenseId, maxCompanies, columns) {
    let qb = db('companies')
        .where('license_id', licenseId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'asc').orderBy('id', 'asc')
        .select(columns);
    if (maxCompanies != null) qb = qb.limit(Number(maxCompanies));
    return qb;
}

/**
 * POST /api/v1/agent/activate
 * Body (validated): { license_key, machine_id, agent_version? }
 */
async function activate(req, res) {
    const { license_key, machine_id, agent_version } = req.body;
    try {
        const parsed = licenseKey.parse(license_key);
        if (!parsed) return R.errorResponse(res, INVALID_KEY_MSG, 404);

        const lic = await db('licenses')
            .where({ key_prefix: parsed.prefix, license_key_hash: parsed.hash })
            .whereNull('deleted_at')
            .first();
        if (!lic) return R.errorResponse(res, INVALID_KEY_MSG, 404);

        if (lic.status !== 'active') {
            return R.errorResponse(res, `This license is ${lic.status}. Please contact support.`, 403);
        }
        const today = new Date().toISOString().slice(0, 10);
        if (lic.valid_until && String(lic.valid_until).slice(0, 10) < today) {
            return R.errorResponse(res, 'This license has expired. Please renew to continue.', 403);
        }

        // Machine binding — bind on first activation; reject a different machine.
        const now = new Date();
        if (!lic.machine_id) {
            await db('licenses').where('id', lic.id).update({
                machine_id, machine_bound_at: now, agent_version: agent_version || null,
                last_seen_at: now, updated_at: now,
            });
        } else if (lic.machine_id !== machine_id) {
            return R.errorResponse(res,
                'This license is already activated on another machine. Ask your administrator to reset it.', 403);
        } else {
            await db('licenses').where('id', lic.id)
                .update({ agent_version: agent_version || lic.agent_version, last_seen_at: now, updated_at: now });
        }

        // Companies this license may sync — only the FIRST max_companies
        // (created_at asc, id asc), on-the-fly. The rest are over the limit and
        // are excluded from sync everywhere (queue / commands / results).
        const companies = await syncingCompanies(
            lic.id, lic.max_companies, ['id', 'name', 'slug', 'status'],
        );

        const agentToken = jwt.sign(
            { kind: 'agent', license_id: lic.id, machine_id },
            AGENT_TOKEN_TTL,
        );

        return R.successResponse(res, {
            agent_token: agentToken,
            license: {
                id: lic.id, holder_name: lic.holder_name, plan: lic.plan,
                valid_until: lic.valid_until, max_companies: lic.max_companies,
            },
            companies,
        }, 'Agent activated.');
    } catch (err) {
        console.error('AgentController.activate error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/heartbeat   (behind authenticateAgent → req.license)
 * The agent pings periodically; we refresh last_seen + version and echo the
 * live license status so the agent halts if it was suspended in the cloud.
 *
 * The response ALSO echoes the per-license AUTO-sync DIRECTION toggles
 * (push_enabled / pull_enabled) so the agent loop can skip the push and/or pull
 * pass when the cloud has them turned off (Requirement 1). Both default to true
 * when the column is null/unreadable, so an older license / pre-migration DB
 * behaves exactly as before (both directions ON).
 *
 * The MASTER "Auto-sync" switch (licenses.sync_enabled) sits ABOVE the two
 * direction toggles: when it is OFF, NOTHING auto-syncs. We enforce that here,
 * cloud-side, by echoing EFFECTIVE gates — push_enabled = sync_enabled &&
 * sync_push_enabled and pull_enabled = sync_enabled && sync_pull_enabled — so
 * the ALREADY-DEPLOYED agent (no rebuild) skips ALL automatic push AND pull
 * while Auto-sync is OFF. sync_enabled is echoed too for completeness. Both the
 * master flag and the direction flags default ON when null/unreadable.
 */
async function heartbeat(req, res) {
    try {
        const now = new Date();
        const patch = {
            last_seen_at: now,
            agent_version: (req.body && req.body.agent_version) || undefined,
            updated_at: now,
        };
        // The agent reports the companies currently OPEN in Tally so the cloud
        // (and the web Sync page) can show what is live. Stored JSON-encoded.
        // Only written when the heartbeat actually carries the array, so a
        // heartbeat sent while Tally is down leaves the last value untouched.
        if (Array.isArray(req.body && req.body.open_companies)) {
            const names = req.body.open_companies
                .map((n) => String(n == null ? '' : n).trim())
                .filter((n) => n);
            patch.last_open_companies = JSON.stringify(names);
        }
        await db('licenses').where('id', req.license.id).update(patch);

        // Per-license AUTO-sync toggles: the MASTER switch (sync_enabled) and the
        // two DIRECTION toggles (push/pull). authenticateAgent selects a fixed
        // column set (no sync flags), so read them here. Each defaults ON when the
        // column is null OR the table predates the migration (best-effort: a read
        // error must never break a working heartbeat).
        let syncEnabled = true;
        let pushEnabled = true;
        let pullEnabled = true;
        try {
            const lic = await db('licenses').where('id', req.license.id)
                .first('sync_enabled', 'sync_push_enabled', 'sync_pull_enabled');
            if (lic) {
                if (lic.sync_enabled      != null) syncEnabled = !!lic.sync_enabled;
                if (lic.sync_push_enabled != null) pushEnabled = !!lic.sync_push_enabled;
                if (lic.sync_pull_enabled != null) pullEnabled = !!lic.sync_pull_enabled;
            }
        } catch (e) {
            syncEnabled = true;
            pushEnabled = true;
            pullEnabled = true;
        }

        // EFFECTIVE gates: the master Auto-sync switch beats the direction toggles.
        // With Auto-sync OFF, BOTH effective gates are false → the deployed agent
        // skips ALL automatic push and pull (no rebuild needed). With Auto-sync ON,
        // the direction toggles decide each pass as before.
        const effectivePush = syncEnabled && pushEnabled;
        const effectivePull = syncEnabled && pullEnabled;

        return R.successResponse(res, {
            status: req.license.status,
            license_id: req.license.id,
            server_time: now.toISOString(),
            // EFFECTIVE auto-sync direction gates the agent loop reads each cycle
            // (master Auto-sync AND the per-direction toggle). Auto-sync OFF → both
            // false so the agent skips every automatic sync pass.
            push_enabled: effectivePush,
            pull_enabled: effectivePull,
            // The raw master switch, echoed for completeness.
            sync_enabled: syncEnabled,
        }, 'ok');
    } catch (err) {
        console.error('AgentController.heartbeat error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/offline   (behind authenticateAgent → req.license)
 *
 * GRACEFUL SHUTDOWN signal. When the agent stops ON PURPOSE (service stop / GUI
 * Stop / Uninstall) it sends this so the cloud flips the license to Disconnected
 * IMMEDIATELY rather than waiting out the ~150s CONNECTED_WINDOW. We do this by
 * CLEARING licenses.last_seen_at (and last_open_companies, since nothing is open
 * any more) → SyncController.summary + LicenseController then compute
 * connected=false at once because last_seen_at is null.
 *
 * Idempotent + safe: clearing an already-null value is a no-op. The agent calls
 * this best-effort/non-blocking, so a failure here must never matter to it. An
 * UNGRACEFUL crash/force-kill never reaches this path and falls back to the
 * 150s window (unavoidable — the cloud cannot ping behind the firewall).
 */
async function offline(req, res) {
    try {
        const now = new Date();
        await db('licenses').where('id', req.license.id).update({
            last_seen_at: null,
            last_open_companies: null,
            updated_at: now,
        });
        return R.successResponse(res, { offline: true }, 'ok');
    } catch (err) {
        console.error('AgentController.offline error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

// Date → Tally's YYYYMMDD. Handles pg Date objects (whose String() is the JS
// toString, NOT yyyy-mm-dd) by reading local Y/M/D components; falls back to
// slicing an ISO/string date. (A bad date made Tally reject vouchers with
// "Voucher date is missing".)
function tallyDate(d) {
    const dt = (d instanceof Date) ? d : (d ? new Date(d) : new Date());
    if (!isNaN(dt)) {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    }
    return String(d || '').slice(0, 10).replace(/-/g, '');
}

/**
 * GET /api/v1/agent/pending   (authenticateAgent → req.license)
 *
 * Everything under this license that still needs pushing to Tally, shaped for
 * the connector. Masters first (ledgers + stock items must exist before
 * vouchers reference them), then vouchers.
 *   • ledgers      — customers (Sundry Debtors) + suppliers (Sundry Creditors)
 *                    that are Tally ledgers and not yet synced (tally_guid NULL)
 *   • stock_items  — products marked as Tally items, not yet synced
 *   • vouchers     — invoices + payments still in 'pending_tally'
 * Batched (50 of each) so a big backlog drains over several passes.
 */
async function pending(req, res) {
    try {
        // SYNC GATE: only the first max_companies companies (created_at asc, id
        // asc) sync — the rest are excluded from the pull/push queue. max_companies
        // isn't on req.license (authenticateAgent selects a fixed set), so read it.
        const licRow = await db('licenses').where('id', req.license.id).first('max_companies');
        const maxCompanies = licRow ? licRow.max_companies : null;
        const companies = await syncingCompanies(
            req.license.id, maxCompanies, ['id', 'name', 'slug', 'tally_guid'],
        );
        const companyIds = companies.map((c) => c.id);
        if (!companyIds.length) {
            return R.successResponse(res, {
                ledgers: [], stock_items: [], vouchers: [], locations: [], categories: [],
                companies: [], companies_to_create: [],
            });
        }

        // Web-made companies not yet created in Tally (tally_guid NULL) — the
        // agent creates each in Tally then reports back so result() stamps the guid.
        const companiesToCreate = companies
            .filter((c) => !c.tally_guid)
            .map((c) => ({ id: c.id, name: c.name }));

        // ── Ledgers ──
        const customers = await db('customers')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_ledger', true).whereNull('tally_guid')
            .limit(50)
            .select('id', 'company_id', 'name', 'gst_number', 'opening_balance');
        const suppliers = await db('suppliers')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_ledger', true).whereNull('tally_guid')
            .limit(50)
            .select('id', 'company_id', 'name', 'gst_number', 'opening_balance');
        const ledgers = [
            ...customers.map((c) => ({
                record_type: 'customer', id: c.id, company_id: c.company_id, name: c.name,
                parent: 'Sundry Debtors', gstin: c.gst_number || null, opening: Number(c.opening_balance) || 0,
            })),
            ...suppliers.map((s) => ({
                record_type: 'supplier', id: s.id, company_id: s.company_id, name: s.name,
                parent: 'Sundry Creditors', gstin: s.gst_number || null, opening: Number(s.opening_balance) || 0,
            })),
        ];

        // ── Stock items ──
        const products = await db('products')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('is_tally_item', true).whereNull('tally_guid')
            .limit(50)
            .select('id', 'company_id', 'name', 'unit', 'hsn_code', 'gst_rate');
        const stock_items = products.map((p) => ({
            record_type: 'product', id: p.id, company_id: p.company_id, name: p.name,
            unit: p.unit || 'Nos', hsn: p.hsn_code || null, gst_rate: Number(p.gst_rate) || 0,
        }));

        // ── Locations → Tally godowns ──
        // All non-deleted locations not yet synced (tally_guid NULL). The
        // locations table HAS tally_guid, so result() stamps it and these stop
        // appearing here. (company_id, id, name are the only columns we push.)
        const locationRows = await db('locations')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .whereNull('tally_guid')
            .limit(50)
            .select('id', 'company_id', 'name');
        const locations = locationRows.map((l) => ({
            record_type: 'location', id: l.id, company_id: l.company_id, name: l.name,
        }));

        // ── Categories → Tally stock groups ──
        // The categories table has NO tally_guid / sync column, so we cannot
        // stamp them and they would re-push every cycle; the Tally-side create is
        // idempotent (a duplicate stock group is harmless) so this is safe. We
        // push all non-deleted categories (batched). result() no-ops on
        // record_type 'category' (nothing to stamp).
        const categoryRows = await db('categories')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .limit(50)
            .select('id', 'company_id', 'name');
        const categories = categoryRows.map((c) => ({
            record_type: 'category', id: c.id, company_id: c.company_id, name: c.name,
        }));

        // ── Vouchers: invoices ──
        const invoices = await db('invoices as i')
            .whereIn('i.company_id', companyIds).whereNull('i.deleted_at')
            .where('i.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'i.customer_id')
            .leftJoin('suppliers as s', 'i.supplier_id', 's.id')
            .limit(50)
            .select('i.id', 'i.company_id', 'i.type', 'i.invoice_no', 'i.invoice_date', 'i.total',
                    'c.name as customer', 's.name as supplier');
        const invIds = invoices.map((i) => i.id);
        let itemsByInvoice = {};
        if (invIds.length) {
            const items = await db('invoice_items as it')
                .whereIn('it.invoice_id', invIds)
                .leftJoin('products as p', 'p.id', 'it.product_id')
                .select('it.invoice_id', 'it.quantity', 'it.rate', 'it.gst_rate',
                        'it.description', 'p.name as product_name');
            itemsByInvoice = items.reduce((acc, it) => {
                (acc[it.invoice_id] = acc[it.invoice_id] || []).push({
                    name: it.product_name || it.description || 'Item',
                    qty: Number(it.quantity) || 0, rate: Number(it.rate) || 0, gst_rate: Number(it.gst_rate) || 0,
                });
                return acc;
            }, {});
        }
        const invoiceVouchers = invoices.map((i) => ({
            record_type: i.type === 'purchase' ? 'purchase_invoice' : 'sales_invoice',
            id: i.id, company_id: i.company_id,
            voucher_kind: i.type === 'purchase' ? 'purchase' : 'sales',
            voucher_no: i.invoice_no, date: tallyDate(i.invoice_date),
            party: i.type === 'purchase' ? i.supplier : i.customer,
            amount: Number(i.total) || 0, items: itemsByInvoice[i.id] || [],
        }));

        // ── Vouchers: payments + receipts ──
        const pays = await db('payments as pm')
            .whereIn('pm.company_id', companyIds).whereNull('pm.deleted_at')
            .where('pm.status', 'pending_tally')
            .leftJoin('customers as c', 'c.id', 'pm.customer_id')
            .leftJoin('suppliers as s', 'pm.supplier_id', 's.id')
            .limit(50)
            .select('pm.id', 'pm.company_id', 'pm.type', 'pm.voucher_no', 'pm.payment_date',
                    'pm.amount', 'pm.mode', 'c.name as customer', 's.name as supplier');
        const payVouchers = pays.map((p) => ({
            record_type: p.type === 'payment' ? 'payment' : 'receipt',
            id: p.id, company_id: p.company_id, voucher_kind: p.type, // 'payment' | 'receipt'
            voucher_no: p.voucher_no, date: tallyDate(p.payment_date),
            party: p.type === 'payment' ? p.supplier : p.customer,
            amount: Number(p.amount) || 0, mode: p.mode || 'Cash',
        }));

        // ── Vouchers: journals ──
        const journals = await db('journals')
            .whereIn('company_id', companyIds).whereNull('deleted_at')
            .where('status', 'pending_tally')
            .limit(50)
            .select('id', 'company_id', 'voucher_no', 'vch_type', 'journal_date', 'dr_ledger', 'cr_ledger', 'amount', 'narration');
        const journalVouchers = journals.map((j) => ({
            record_type: 'journal', id: j.id, company_id: j.company_id, voucher_kind: 'journal',
            voucher_no: j.voucher_no, vch_type: j.vch_type || 'Journal', date: tallyDate(j.journal_date),
            dr_ledger: j.dr_ledger, cr_ledger: j.cr_ledger,
            amount: Number(j.amount) || 0, narration: j.narration || '',
        }));

        return R.successResponse(res, {
            companies,
            companies_to_create: companiesToCreate,
            ledgers, stock_items, locations, categories,
            vouchers: [...invoiceVouchers, ...payVouchers, ...journalVouchers],
        });
    } catch (err) {
        console.error('AgentController.pending error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/result   (authenticateAgent → req.license)
 * Body: { results: [{ record_type, record_id, company_id, status:'synced'|'failed',
 *                     tally_guid?, tally_voucher_no?, message? }] }
 * Applies each result to the source record (so it stops appearing in /pending)
 * and writes a tally_sync_logs audit row.
 */
async function result(req, res) {
    try {
        const results = Array.isArray(req.body && req.body.results) ? req.body.results : [];
        // Only accept results for the FIRST max_companies (syncing) companies —
        // a company over the sync limit must not be pushed/stamped.
        const licRow = await db('licenses').where('id', req.license.id).first('max_companies');
        const maxCompanies = licRow ? licRow.max_companies : null;
        const syncing = await syncingCompanies(req.license.id, maxCompanies, ['id']);
        const allowed = new Set(syncing.map((c) => Number(c.id)));

        let processed = 0;
        for (const r of results) {
            const cid = Number(r.company_id);
            if (!allowed.has(cid)) continue;          // never touch another license's data
            const now = new Date();
            const synced = r.status === 'synced';

            if (r.record_type === 'customer' || r.record_type === 'supplier') {
                if (synced) {
                    const table = r.record_type === 'customer' ? 'customers' : 'suppliers';
                    await db(table).where({ id: r.record_id, company_id: cid })
                        .update({ tally_guid: r.tally_guid || 'synced', tally_synced_at: now, updated_at: now });
                }
            } else if (r.record_type === 'product') {
                if (synced) {
                    await db('products').where({ id: r.record_id, company_id: cid })
                        .update({ tally_guid: r.tally_guid || 'synced', tally_synced_at: now, updated_at: now });
                }
            } else if (r.record_type === 'sales_invoice' || r.record_type === 'purchase_invoice') {
                // invoices track sync via status + tally_voucher_no (no synced_at column).
                await db('invoices').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null,
                    tally_guid: r.tally_guid || null, updated_at: now,
                });
            } else if (r.record_type === 'payment' || r.record_type === 'receipt') {
                await db('payments').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null, updated_at: now,
                });
            } else if (r.record_type === 'journal') {
                await db('journals').where({ id: r.record_id, company_id: cid }).update({
                    status: synced ? 'created' : 'failed',
                    tally_voucher_no: r.tally_voucher_no || null, updated_at: now,
                });
            } else if (r.record_type === 'company') {
                // Web-made company now created in Tally → stamp its guid so
                // /pending stops listing it under companies_to_create.
                if (synced) {
                    await db('companies').where({ id: r.record_id, license_id: req.license.id })
                        .whereNull('deleted_at')
                        .update({ tally_guid: r.tally_guid || 'tally', updated_at: now });
                }
            } else if (r.record_type === 'location') {
                // Location pushed as a Tally godown → stamp tally_guid +
                // tally_synced_at so /pending stops returning it.
                if (synced) {
                    await db('locations').where({ id: r.record_id, company_id: cid })
                        .whereNull('deleted_at')
                        .update({ tally_guid: r.tally_guid || 'tally', tally_synced_at: now, updated_at: now });
                }
            } else if (r.record_type === 'category') {
                // Category pushed as a Tally stock group. The categories table
                // has no tally_guid/sync column, so there is nothing to stamp and
                // the category is necessarily RE-PUSHED every cycle (the Tally-side
                // STOCKGROUP create is idempotent, so this is harmless in Tally).
                // We deliberately DO NOT write a tally_sync_logs audit row here:
                // without a sync column we cannot tell a first push from a repeat,
                // so logging every cycle would grow tally_sync_logs without bound
                // (up to 50 rows per company per cycle, forever). Count it as
                // processed but skip the audit write.
                processed += 1;
                continue;
            } else {
                continue;
            }

            await db('tally_sync_logs').insert({
                company_id: cid, module: r.record_type, record_type: r.record_type,
                record_id: r.record_id, direction: 'push',
                status: synced ? 'synced' : 'failed',
                message: r.message || null, retry_count: 0,
                synced_at: synced ? now : null,
            });
            processed += 1;
        }

        return R.successResponse(res, { processed }, 'Results recorded.');
    } catch (err) {
        console.error('AgentController.result error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/import   (authenticateAgent → req.license)
 *
 * Tally → Cloud PULL: the agent reads masters + vouchers from the open Tally
 * company and sends them here to be upserted into the cloud. Body:
 *   { company_id, ledgers:[{name,parent}], stock_items:[{name,closing}],
 *     godowns:[{name}], vouchers:[{vtype,vno,party,amount,date}] }
 * Ledgers are classified by their Tally parent group — "Sundry Debtors" →
 * customers, "Sundry Creditors" → suppliers (system ledgers like Cash / P&L are
 * skipped). Matching is by name (company-scoped, case-insensitive): an existing
 * record is just LINKED (tally_guid set); a new name is INSERTED. Stock items →
 * products; godowns → locations. Vouchers (Day Book) map to payments / invoices
 * / journals: receipt+payment → payments (NULL party FK when Cash/unmatched, so
 * cash is not lost), sales/purchase → invoices, Journal → journals, Credit Note
 * → sales invoice + Debit Note → purchase invoice (returns). Idempotent via
 * tally_voucher_no (vouchers) / lower(name) (godowns). Every import writes a
 * direction:'pull' tally_sync_logs row.
 */
async function importFromTally(req, res) {
    try {
        const licenseId = req.license.id;

        // Resolve the target cloud company. Prefer an explicit, valid company_id;
        // otherwise FIND-OR-CREATE by the Tally company NAME under this license —
        // so a Tally company AUTO-CREATES its cloud company on first pull
        // (respecting the license's max_companies cap). 422 if neither is usable.
        const rawId = Number(req.body && req.body.company_id);
        const companyName = String((req.body && req.body.company_name) || '').trim();
        let cid = null;
        let companyCreated = false;

        if (rawId) {
            const owned = await db('companies').where({ id: rawId, license_id: licenseId })
                .whereNull('deleted_at').first('id');
            if (owned) cid = owned.id;
        }
        if (!cid && companyName) {
            const existing = await db('companies').where('license_id', licenseId).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [companyName.toLowerCase()]).first('id');
            if (existing) {
                cid = existing.id;
            } else {
                const lic = await db('licenses').where('id', licenseId).first('max_companies');
                const [{ c }] = await db('companies').where('license_id', licenseId)
                    .whereNull('deleted_at').count({ c: '*' });
                if (lic && lic.max_companies != null && Number(c) >= Number(lic.max_companies)) {
                    return R.errorResponse(res,
                        `Company limit reached for this license (max ${lic.max_companies}). Could not add '${companyName}'.`, 422);
                }
                // Unique URL slug derived from the Tally company name.
                const base = (companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '').slice(0, 40)) || 'company';
                let slug = base;
                while (await db('companies').where('slug', slug).first('id')) {
                    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
                }
                const [row] = await db('companies').insert({
                    name: companyName, slug, license_id: licenseId, status: 'Active',
                    // It came FROM Tally, so it already exists there — stamp the
                    // guid so the cloud->Tally push never tries to re-create it.
                    tally_guid: 'tally',
                    created_at: new Date(), updated_at: new Date(),
                }).returning('id');
                cid = row.id || row;
                companyCreated = true;
            }
        }
        if (!cid) {
            return R.errorResponse(res, 'No target company — send company_name (the Tally company) or a valid company_id.', 422);
        }

        // SYNC GATE: refuse a pull into a company that is OVER the license sync
        // limit (only the first max_companies, created_at asc, may sync). A
        // just-created company passed the cap check above, so it is in the set.
        const licGate = await db('licenses').where('id', licenseId).first('max_companies');
        const syncSet = await syncingCompanies(licenseId, licGate ? licGate.max_companies : null, ['id']);
        const syncIds = new Set(syncSet.map((c) => Number(c.id)));
        if (!syncIds.has(Number(cid))) {
            return R.errorResponse(res,
                'This company is over the license sync limit (max_companies) and does not sync. Raise the limit to sync it.', 403);
        }

        const ledgers    = Array.isArray(req.body.ledgers) ? req.body.ledgers : [];
        const stockItems = Array.isArray(req.body.stock_items) ? req.body.stock_items : [];
        const vouchers   = Array.isArray(req.body.vouchers) ? req.body.vouchers : [];
        const godowns    = Array.isArray(req.body.godowns) ? req.body.godowns : [];
        const groups     = Array.isArray(req.body.groups) ? req.body.groups : [];
        adbg(`/agent/import RECEIVED  license=${licenseId} company="${companyName}" cid=${cid} -> ` +
             `ledgers=${ledgers.length} stock=${stockItems.length} vouchers=${vouchers.length} godowns=${godowns.length}` +
             (ledgers.length ? `  sampleLedger="${(ledgers[0] && (ledgers[0].name || ledgers[0].Name)) || '?'}"` :
                               `  (0 ledgers — the agent's open Tally company is empty / wrong)`));
        const now = new Date();

        // ── FULL MIRROR: sync the Tally COMPANY MASTER onto the cloud company
        //    record. Only FILL EMPTY fields so a company-admin's manual edits are
        //    NOT clobbered on every pull (page stays editable + both-side). ──
        const cm = req.body.company_master;
        if (cm && typeof cm === 'object' && cid) {
            try {
                const comp = await db('companies').where('id', cid)
                    .first('email', 'mobile', 'gst_number', 'pan_number', 'address', 'financial_year');
                const patch = {};
                if (cm.email && !comp.email)        patch.email = String(cm.email);
                if (cm.phone && !comp.mobile)       patch.mobile = String(cm.phone);
                if (cm.gstin && !comp.gst_number)   patch.gst_number = String(cm.gstin);
                if (cm.pan && !comp.pan_number)     patch.pan_number = String(cm.pan);
                if (cm.books_from && !comp.financial_year) patch.financial_year = String(cm.books_from);
                if (!comp.address && (cm.address || cm.state || cm.pincode)) {
                    patch.address = [cm.address, cm.state, cm.pincode, cm.country].filter(Boolean).join(', ');
                }
                if (Object.keys(patch).length) {
                    patch.updated_at = now;
                    await db('companies').where('id', cid).update(patch);
                }
            } catch (e) { /* best-effort: company master never blocks the import */ }
        }

        const counts = { customers_new: 0, customers_linked: 0, suppliers_new: 0,
            suppliers_linked: 0, products_new: 0, products_linked: 0,
            masters_updated: 0, vouchers_new: 0, journals_new: 0, locations_new: 0,
            skipped: 0, failed: 0 };
        // Per-record outcomes so the agent can show the pull ONE BY ONE
        // (created / linked / updated). Unchanged records are NOT listed here.
        const details = [];

        // ── Per-company watermark (the cloud OWNS it). Load or create the
        //    tally_sync_state row; master_alter_id is the largest Tally ALTERID
        //    we've already processed. A master is SKIPPED when its alterid is
        //    present AND <= the watermark (genuinely unchanged). We advance the
        //    watermark to the max alterid seen this pass at the end. ──
        let state = await db('tally_sync_state').where('company_id', cid).first();
        if (!state) {
            await db('tally_sync_state').insert({
                company_id: cid, master_alter_id: 0, voucher_alter_id: 0,
                created_at: now, updated_at: now,
            });
            state = { master_alter_id: 0 };
        }
        const watermark = Number(state.master_alter_id) || 0;
        let maxAlterId = watermark;
        const aid = (v) => {
            const n = Number(v && v.alterid);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        // Normalise a numeric-ish value (opening/gst), tolerating Tally junk.
        const num = (v) => {
            const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
            return Number.isFinite(n) ? n : 0;
        };

        // Tally YYYYMMDD → YYYY-MM-DD (best-effort).
        const tdate = (s) => {
            const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/);
            return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        };

        async function logPull(module, recordId, name) {
            await db('tally_sync_logs').insert({
                company_id: cid, module, record_type: module, record_id: recordId || null,
                direction: 'pull', status: 'synced', message: `Imported from Tally: ${name}`,
                retry_count: 0, synced_at: now,
            });
        }

        // Resilience helper: ONE bad record must NEVER abort the whole import.
        // Every record loop below is wrapped so a failure is LOGGED (a 'failed'
        // sync log row the Dashboard shows + console + AGENT_DEBUG) and the import
        // continues with the next record. Never throws (logging can't break sync).
        async function logPullError(module, name, err) {
            const detail = (err && (err.detail || err.message))
                ? String(err.detail || err.message).slice(0, 480) : 'Import error';
            try {
                await db('tally_sync_logs').insert({
                    company_id: cid, module, record_type: module, record_id: null,
                    direction: 'pull', status: 'failed', message: `${name}: ${detail}`,
                    retry_count: 0, synced_at: now,
                });
            } catch (_) { /* logging must never break the import */ }
            try { console.error(`[import] ${module} "${name}" FAILED: ${detail}`); } catch (_) { /* noop */ }
            adbg(`IMPORT FAILED  module=${module} name="${name}" -> ${detail}`);
        }

        // ── FULL MIRROR: account GROUPS -> tally_groups (Balance Sheet / P&L
        //    hierarchy). Incremental on ALTERID; idempotent via (company_id, name). ──
        for (const g of groups) {
            try {
                const gname = String(g.name || '').trim();
                if (!gname) continue;
                const galter = aid(g);
                if (galter && galter <= watermark) continue;
                if (galter > maxAlterId) maxAlterId = galter;
                const grow = {
                    company_id: cid, name: gname, parent: String(g.parent || ''),
                    is_revenue: !!g.is_revenue, is_deemed_positive: g.is_deemed_positive !== false,
                    tally_guid: 'tally', tally_alter_id: galter, updated_at: now,
                };
                await db('tally_groups').insert({ ...grow, created_at: now })
                    .onConflict(['company_id', 'name']).merge(grow);
            } catch (e) { /* best-effort */ }
        }

        // ── FULL MIRROR: upsert EVERY ledger (all groups, not just debtors/
        //    creditors) into tally_ledgers with its opening balance + GSTIN. This
        //    is the account-level data the Trial Balance / Balance Sheet / Ledger
        //    statement are derived from. Incremental on ALTERID; idempotent via
        //    (company_id, name). Best-effort per ledger. ──
        for (const l of ledgers) {
            try {
                const lname = String(l.name || '').trim();
                if (!lname) continue;
                const lalter = aid(l);
                if (lalter && lalter <= watermark) continue;   // unchanged -> skip
                if (lalter > maxAlterId) maxAlterId = lalter;
                const opening = parseFloat(String(l.opening || '0').replace(/[^0-9.\-]/g, '')) || 0;
                const row = {
                    company_id: cid, name: lname, parent: String(l.parent || ''),
                    opening_balance: opening, gstin: l.gstin || null,
                    tally_guid: 'tally', tally_alter_id: lalter, updated_at: now,
                };
                await db('tally_ledgers').insert({ ...row, created_at: now })
                    .onConflict(['company_id', 'name']).merge(row);
            } catch (e) { /* best-effort: one bad ledger never aborts the import */ }
        }

        for (const l of ledgers) {
          try {
            const name = String(l.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }
            const parent = String(l.parent || '').toLowerCase();
            const table = parent.includes('debtor') ? 'customers'
                        : parent.includes('creditor') ? 'suppliers' : null;
            if (!table) { counts.skipped += 1; continue; }   // skip Cash/Bank/P&L/etc.

            const alterId = aid(l);
            // Incremental: an unchanged master (alterid present AND <= watermark)
            // is skipped without a DB hit. New/changed masters fall through.
            if (alterId && alterId <= watermark) { counts.skipped += 1; continue; }
            if (alterId > maxAlterId) maxAlterId = alterId;

            const gstin = l.gstin ? String(l.gstin).trim() : null;
            const opening = num(l.opening);

            const existing = await db(table).where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [name.toLowerCase()])
                .first('id', 'tally_guid', 'gst_number', 'opening_balance');
            if (existing) {
                // UPDATE the synced fields when Tally's value actually differs
                // (so a GST/opening change in Tally reaches the cloud). Always
                // ensure the link is set. Log only on a real change.
                const upd = {};
                if (gstin && gstin !== (existing.gst_number || '')) upd.gst_number = gstin;
                if (Number(existing.opening_balance) !== opening) upd.opening_balance = opening;
                if (!existing.tally_guid) upd.tally_guid = 'tally';

                const ttype = table === 'customers' ? 'customer' : 'supplier';
                if (Object.keys(upd).length) {
                    upd.updated_at = now;
                    await db(table).where('id', existing.id).update(upd);
                    // HISTORY (best-effort): Tally changed this master. before =
                    // the snapshot we read; after = before + the applied changes.
                    await recordHistory(db, {
                        company_id: cid, module: table, record_type: ttype,
                        record_id: existing.id, action: 'updated', source: 'tally',
                        before: existing, after: { ...existing, ...upd },
                        changed_by: null, note: 'Tally sync',
                    });
                    if (!existing.tally_guid) {
                        counts[table === 'customers' ? 'customers_linked' : 'suppliers_linked'] += 1;
                        details.push({ type: ttype, name, action: 'linked' });
                    } else {
                        counts.masters_updated += 1;
                        details.push({ type: ttype, name, action: 'updated' });
                    }
                    await logPull(ttype, existing.id, name);
                } else {
                    counts.skipped += 1;   // already in sync → no write, no log spam
                }
            } else {
                const insertRow = {
                    company_id: cid, name, status: 'Active', is_tally_ledger: true,
                    tally_guid: 'tally', gst_number: gstin, opening_balance: opening,
                    created_at: now, updated_at: now,
                };
                const [row] = await db(table).insert(insertRow).returning('id');
                const newId = row.id || row;
                const ttype = table === 'customers' ? 'customer' : 'supplier';
                // HISTORY (best-effort): a new master pulled from Tally.
                await recordHistory(db, {
                    company_id: cid, module: table, record_type: ttype,
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts[table === 'customers' ? 'customers_new' : 'suppliers_new'] += 1;
                details.push({ type: ttype, name, action: 'created' });
                await logPull(ttype, newId, name);
            }
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('customer/supplier', String((l && l.name) || '?'), err);
          }
        }

        for (const s of stockItems) {
          try {
            const name = String(s.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }

            const alterId = aid(s);
            if (alterId && alterId <= watermark) { counts.skipped += 1; continue; }
            if (alterId > maxAlterId) maxAlterId = alterId;

            const closing = num(s.closing);
            const unit = s.unit ? String(s.unit).trim() : null;
            const hsn = s.hsn ? String(s.hsn).trim() : null;
            const salesPrice = num(s.sales_price);
            const purchasePrice = num(s.purchase_price);

            const existing = await db('products').where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [name.toLowerCase()])
                .first('id', 'tally_guid', 'unit', 'hsn_code', 'opening_stock', 'sales_price', 'purchase_price');
            if (existing) {
                const upd = {};
                if (unit && unit !== (existing.unit || '')) upd.unit = unit;
                if (hsn && hsn !== (existing.hsn_code || '')) upd.hsn_code = hsn;
                if (Number(existing.opening_stock) !== closing) upd.opening_stock = closing;
                if (salesPrice && Number(existing.sales_price) !== salesPrice) upd.sales_price = salesPrice;
                if (purchasePrice && Number(existing.purchase_price) !== purchasePrice) upd.purchase_price = purchasePrice;
                if (!existing.tally_guid) upd.tally_guid = 'tally';

                if (Object.keys(upd).length) {
                    upd.updated_at = now;
                    await db('products').where('id', existing.id).update(upd);
                    // HISTORY (best-effort): Tally changed this product.
                    await recordHistory(db, {
                        company_id: cid, module: 'products', record_type: 'product',
                        record_id: existing.id, action: 'updated', source: 'tally',
                        before: existing, after: { ...existing, ...upd },
                        changed_by: null, note: 'Tally sync',
                    });
                    if (!existing.tally_guid) {
                        counts.products_linked += 1;
                        details.push({ type: 'product', name, action: 'linked' });
                    } else {
                        counts.masters_updated += 1;
                        details.push({ type: 'product', name, action: 'updated' });
                    }
                    await logPull('product', existing.id, name);
                } else {
                    counts.skipped += 1;
                }
            } else {
                const insertRow = {
                    company_id: cid, name, status: 'Active', is_tally_item: true, tally_guid: 'tally',
                    unit: unit || 'Nos', hsn_code: hsn, opening_stock: closing,
                    purchase_price: purchasePrice, sales_price: salesPrice, gst_rate: 0, created_at: now, updated_at: now,
                };
                const [row] = await db('products').insert(insertRow).returning('id');
                const newId = row.id || row;
                // HISTORY (best-effort): a new product pulled from Tally.
                await recordHistory(db, {
                    company_id: cid, module: 'products', record_type: 'product',
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts.products_new += 1;
                details.push({ type: 'product', name, action: 'created' });
                await logPull('product', newId, name);
            }
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('product', String((s && s.name) || '?'), err);
          }
        }

        // ── Godowns → locations. Each Tally godown becomes a location row
        //    (is_tally_godown=true, tally_guid='tally'). Idempotent by
        //    lower(name) per company: an existing same-named location is left
        //    untouched (no duplicate); a new name is INSERTED. ──
        for (const g of godowns) {
          try {
            const name = String(g.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }

            const existing = await db('locations').where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id');
            if (existing) { counts.skipped += 1; continue; }   // already present → no dup

            const insertRow = {
                company_id: cid, name, status: 'Active',
                is_tally_godown: true, tally_guid: 'tally', tally_synced_at: now,
                created_at: now, updated_at: now,
            };
            const [row] = await db('locations').insert(insertRow).returning('id');
            const newId = row.id || row;
            // HISTORY (best-effort): a new location (godown) pulled from Tally.
            await recordHistory(db, {
                company_id: cid, module: 'locations', record_type: 'location',
                record_id: newId, action: 'created', source: 'tally',
                before: null, after: { id: newId, ...insertRow },
                changed_by: null, note: 'Tally sync',
            });
            counts.locations_new += 1;
            details.push({ type: 'location', name, action: 'created' });
            await logPull('location', newId, name);
          } catch (err) {
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('location', String((g && g.name) || '?'), err);
          }
        }

        // ── Vouchers (Day Book): receipts/payments → payments, sales/purchase
        //    → invoices, Journal → journals, Credit/Debit Note → sales/purchase
        //    invoice (returns captured as the matching invoice type). Party is
        //    matched by name; an unmatched/Cash party leaves the party FK NULL
        //    (the value is still recorded — cash transactions are not dropped).
        //    Idempotent via tally_voucher_no. ──
        for (const v of vouchers) {
          // Per-voucher guard: ONE bad/duplicate voucher must never abort the whole
          // pull (a single duplicate purchase no. was 500-ing the entire import, so
          // masters synced but NO vouchers did). A unique-violation (23505) = already
          // imported -> skip; any OTHER error still propagates so real bugs surface.
          try {
            const vt = String(v.vtype || '').toLowerCase();
            const vno = String(v.vno || '').trim();
            const amount = Number(v.amount) || 0;
            const date = tdate(v.date);
            const partyName = String(v.party || '').trim();
            const guid = String((v && v.guid) || '').trim();

            // ── FULL MIRROR: store this voucher's COMPLETE double-entry (every
            //    ledger debit/credit) into tally_voucher_entries BEFORE any skip,
            //    so even Contra / zero-party vouchers feed the Trial Balance /
            //    Balance Sheet / P&L / Ledger statement. Replace-by-GUID = idempotent
            //    (re-pull overwrites, never duplicates). ──
            if (guid && Array.isArray(v.entries) && v.entries.length) {
                try {
                    await db('tally_voucher_entries').where({ company_id: cid, voucher_guid: guid }).del();
                    const erows = v.entries.map((e) => ({
                        company_id: cid, voucher_guid: guid, voucher_type: v.vtype || null,
                        voucher_no: vno || null, voucher_date: date || null,
                        ledger_name: String(e.ledger || '').trim(),
                        amount: Number(e.amount) || 0, is_debit: !!e.is_debit,
                        tally_alter_id: Number(v.alterid) || 0, created_at: now,
                    })).filter((r) => r.ledger_name);
                    if (erows.length) await db('tally_voucher_entries').insert(erows);
                } catch (e) { /* best-effort: entries never block the import */ }
            }
            // FULL MIRROR: inventory movement -> tally_inventory_entries (Stock value).
            if (guid && Array.isArray(v.inventory) && v.inventory.length) {
                try {
                    await db('tally_inventory_entries').where({ company_id: cid, voucher_guid: guid }).del();
                    const irows = v.inventory.map((it) => ({
                        company_id: cid, voucher_guid: guid, voucher_date: date || null,
                        item_name: String(it.item || '').trim(),
                        qty: Number(it.qty) || 0, rate: Number(it.rate) || 0,
                        amount: Number(it.amount) || 0, created_at: now,
                    })).filter((r) => r.item_name);
                    if (irows.length) await db('tally_inventory_entries').insert(irows);
                } catch (e) { /* best-effort */ }
            }

            if (!amount || !vno) { counts.skipped += 1; continue; }

            // GUID idempotency: the Tally voucher GUID is the STABLE unique key
            // (voucher NUMBERS repeat - purchases reuse the supplier bill no). If
            // this exact voucher was already imported (invoices/journals carry the
            // guid), skip it - so re-pulling an AlterID window is harmless.
            if (guid) {
                const already = await db('invoices').where({ company_id: cid, tally_guid: guid }).first('id')
                             || await db('journals').where({ company_id: cid, tally_guid: guid }).first('id');
                if (already) { counts.skipped += 1; continue; }
            }

            // Per-iteration history capture state (set by the payment/invoice
            // insert branches below; read by the shared recordHistory call).
            let newVoucherId = null;
            let voucherAfter = null;

            const isReceipt = vt.indexOf('receipt') > -1;
            const isPayment = vt.indexOf('payment') > -1;
            // A Credit Note is a sales return; a Debit Note a purchase return.
            // The cloud has no return type, so capture each as the matching
            // invoice type (Credit Note → sales, Debit Note → purchase).
            const isCreditNote = vt.indexOf('credit') > -1;
            const isDebitNote = vt.indexOf('debit') > -1;
            const isJournal = vt.indexOf('journal') > -1;
            // Plain sales/purchase vouchers. Exclude credit/debit notes which
            // also contain neither 'sales' nor 'purchase' but are handled above.
            const isSales = vt.indexOf('sales') > -1 || isCreditNote;
            const isPurchase = vt.indexOf('purchase') > -1 || isDebitNote;

            if (isJournal) {
                // Journal voucher → journals table. The day_book voucher only
                // gives party/amount/date, so set dr_ledger=party (best-effort).
                // cr_ledger is NOT NULL in the schema, so use '' when unknown.
                const dup = await db('journals').where({ company_id: cid, tally_voucher_no: vno })
                    .whereNull('deleted_at').first('id');
                if (dup) { counts.skipped += 1; continue; }
                // journal_date is NOT NULL in the schema; tdate() returns null
                // for an unparseable Tally date, so fall back to today rather
                // than letting one bad date abort the whole import pass.
                const journalDate = date || now.toISOString().slice(0, 10);
                // CONTENT dedupe: a journal already pushed cloud→Tally exists in
                // the cloud (Tally auto-numbers, so its vno never matches our
                // voucher_no). Skip if a non-deleted journal with the same
                // (company_id, amount, date, dr_ledger, cr_ledger) already exists
                // so a pushed journal is not re-imported as a duplicate row.
                const contentDup = await db('journals')
                    .where({ company_id: cid, journal_date: journalDate, amount,
                             dr_ledger: partyName || '(unknown)', cr_ledger: '' })
                    .whereNull('deleted_at').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const insertRow = {
                    company_id: cid, voucher_no: vno, vch_type: 'Journal',
                    journal_date: journalDate, dr_ledger: partyName || '(unknown)', cr_ledger: '',
                    amount, narration: null, status: 'created',
                    tally_voucher_no: vno, tally_guid: guid || 'tally',
                    created_at: now, updated_at: now,
                };
                const [row] = await db('journals').insert(insertRow).returning('id');
                const newId = row.id || row;
                // HISTORY (best-effort): a journal voucher created from Tally.
                await recordHistory(db, {
                    company_id: cid, module: 'journals', record_type: 'journal',
                    record_id: newId, action: 'created', source: 'tally',
                    before: null, after: { id: newId, ...insertRow },
                    changed_by: null, note: 'Tally sync',
                });
                counts.journals_new += 1;
                details.push({ type: 'journal', name: `Journal ${vno}`, action: 'created' });
                await logPull('journal', newId, `Journal ${vno}`);
                continue;
            }

            if (!isReceipt && !isPayment && !isSales && !isPurchase) { counts.skipped += 1; continue; }

            // Resolve the party to a customer (receipt/sales/credit note) or
            // supplier (payment/purchase/debit note). Unmatched (e.g. Cash/Bank,
            // or a party that isn't a cloud customer/supplier) → NULL FK, but
            // the voucher is STILL recorded so the value is not lost.
            const partyTable = (isReceipt || isSales) ? 'customers' : 'suppliers';
            let partyId = null;
            if (partyName) {
                const party = await db(partyTable).where('company_id', cid).whereNull('deleted_at')
                    .whereRaw('lower(name) = ?', [partyName.toLowerCase()]).first('id');
                if (party) partyId = party.id;
            }

            if (isReceipt || isPayment) {
                const type = isReceipt ? 'receipt' : 'payment';
                const dup = await db('payments').where({ company_id: cid, type, tally_voucher_no: vno })
                    .whereNull('deleted_at').first('id');
                if (dup) { counts.skipped += 1; continue; }
                // CONTENT dedupe: a payment/receipt already pushed cloud→Tally is
                // already a cloud row; Tally auto-numbers so its vno never matches
                // our voucher_no. Skip if a non-deleted same (company_id, type,
                // party id-or-null, date, amount) payment already exists so it is
                // not re-imported as a duplicate.
                const payPartyCol = isReceipt ? 'customer_id' : 'supplier_id';
                const contentDup = await db('payments')
                    .where({ company_id: cid, type, payment_date: date, amount,
                             [payPartyCol]: partyId })
                    .whereNull('deleted_at').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const payRow = {
                    company_id: cid, type, voucher_no: vno, payment_date: date,
                    amount, mode: 'Cash', status: 'created', tally_voucher_no: vno,
                    party_type: partyId ? (isReceipt ? 'customer' : 'supplier') : null,
                    [isReceipt ? 'customer_id' : 'supplier_id']: partyId,
                    created_at: now, updated_at: now,
                };
                const [pr] = await db('payments').insert(payRow).returning('id');
                newVoucherId = pr ? (pr.id || pr) : null;
                voucherAfter = newVoucherId != null ? { id: newVoucherId, ...payRow } : payRow;
            } else {
                const type = isSales ? 'sales' : 'purchase';
                // Dedupe on the SAME columns as the unique constraint
                // (company_id, type, invoice_no) and do NOT filter deleted_at —
                // the constraint spans deleted rows too. The old check used
                // tally_voucher_no + whereNull(deleted_at), so a duplicate slipped
                // past it and the INSERT then 500-ed the WHOLE import.
                const dup = await db('invoices')
                    .where({ company_id: cid, type, invoice_no: vno })
                    .first('id');
                if (dup) { counts.skipped += 1; continue; }
                // CONTENT dedupe: an invoice already pushed cloud→Tally is already
                // a cloud row; Tally auto-numbers so its vno never matches our
                // invoice_no. Skip if a non-deleted same (company_id, type, party
                // id-or-null, date, total) invoice already exists so it is not
                // re-imported as a duplicate.
                const invPartyCol = isSales ? 'customer_id' : 'supplier_id';
                const contentDup = await db('invoices')
                    .where({ company_id: cid, type, invoice_date: date, total: amount,
                             [invPartyCol]: partyId })
                    .whereNull('deleted_at').first('id');
                if (contentDup) { counts.skipped += 1; continue; }
                const invRow = {
                    company_id: cid, type, invoice_no: vno, invoice_date: date,
                    [isSales ? 'customer_id' : 'supplier_id']: partyId,
                    taxable: amount, cgst: 0, sgst: 0, igst: 0, tax_amount: 0, total: amount,
                    status: 'created', tally_voucher_no: vno, tally_guid: guid || null,
                    created_at: now, updated_at: now,
                };
                const [ir] = await db('invoices').insert(invRow).returning('id');
                newVoucherId = ir ? (ir.id || ir) : null;
                voucherAfter = newVoucherId != null ? { id: newVoucherId, ...invRow } : invRow;
            }
            const label = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isCreditNote ? 'sales invoice (credit note)'
                : isDebitNote ? 'purchase invoice (debit note)'
                : isSales ? 'sales invoice' : 'purchase invoice';
            const logModule = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isSales ? 'sales_invoice' : 'purchase_invoice';
            // History module slug (route-style) for this voucher kind.
            const histModule = isReceipt ? 'receipts' : isPayment ? 'payments'
                : isSales ? 'sales-invoices' : 'purchase-invoices';
            const histType = isReceipt ? 'receipt' : isPayment ? 'payment'
                : isSales ? 'sales-invoice' : 'purchase-invoice';
            // HISTORY (best-effort): a voucher created from Tally.
            await recordHistory(db, {
                company_id: cid, module: histModule, record_type: histType,
                record_id: newVoucherId, action: 'created', source: 'tally',
                before: null, after: voucherAfter,
                changed_by: null, note: 'Tally sync',
            });
            counts.vouchers_new += 1;
            details.push({ type: label, name: `${v.vtype} ${vno}`, action: 'created' });
            await logPull(logModule, newVoucherId, `${v.vtype} ${vno}`);
          } catch (vErr) {
            // A duplicate (already-imported) voucher → silent skip. ANY other error
            // is LOGGED and the pull keeps going (one bad voucher must not abort the rest).
            if (vErr && vErr.code === '23505') { counts.skipped += 1; continue; }
            counts.failed = (counts.failed || 0) + 1;
            await logPullError('voucher', String((v && (String(v.vtype || '') + ' ' + (v.vno || ''))) || '?'), vErr);
            continue;
          }
        }

        // Advance the per-company watermark to the largest ALTERID seen this
        // pass (so unchanged masters are skipped next cycle) + stamp last_pull_at.
        const stateUpd = { last_pull_at: now, updated_at: now };
        if (maxAlterId > watermark) stateUpd.master_alter_id = maxAlterId;
        await db('tally_sync_state').where('company_id', cid).update(stateUpd);

        counts.company_id = cid;
        counts.company_created = companyCreated;
        counts.master_alter_id = Math.max(maxAlterId, watermark);
        counts.details = details;          // per-record outcomes for one-by-one display
        adbg(`/agent/import RESULT    company="${companyName}" cid=${cid} created=${companyCreated} -> ` +
             `cust_new=${counts.customers_new} supp_new=${counts.suppliers_new} prod_new=${counts.products_new} ` +
             `updated=${counts.masters_updated} vouchers_new=${counts.vouchers_new} journals_new=${counts.journals_new} ` +
             `locations_new=${counts.locations_new} skipped=${counts.skipped}`);
        return R.successResponse(res, counts, 'Imported from Tally.');
    } catch (err) {
        console.error('AgentController.importFromTally error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /api/v1/agent/commands   (authenticateAgent → req.license)
 *
 * The agent polls this each cycle to drain its command queue. In ONE
 * transaction we claim up to 10 'pending' rows for THIS agent's license:
 * select … FOR UPDATE (orderBy id), then flip them to 'running' + picked_at=now,
 * so two concurrent agents / a re-poll never run the same command twice.
 *
 * Each returned command flattens company_name / company_number out of the JSON
 * payload (null-safe) so the agent never has to parse payload itself.
 */
async function getCommands(req, res) {
    try {
        const now = new Date();
        // SYNC GATE: a command that targets a specific company is only served
        // when that company is within the license's first max_companies (the
        // syncing set). Company-less commands (company_id NULL, e.g. self_update)
        // always pass. Computed on-the-fly from max_companies.
        const licRow = await db('licenses').where('id', req.license.id).first('max_companies');
        const maxCompanies = licRow ? licRow.max_companies : null;
        const syncing = await syncingCompanies(req.license.id, maxCompanies, ['id']);
        const allowedCompanyIds = syncing.map((c) => Number(c.id));

        const claimed = await db.transaction(async (trx) => {
            const rows = await trx('agent_commands')
                .where({ license_id: req.license.id, status: 'pending' })
                .where((b) => {
                    b.whereNull('company_id');
                    if (allowedCompanyIds.length) b.orWhereIn('company_id', allowedCompanyIds);
                })
                .orderBy('id', 'asc')
                .limit(10)
                .forUpdate()
                .select('id', 'type', 'company_id', 'payload');

            if (rows.length) {
                const ids = rows.map((r) => r.id);
                await trx('agent_commands')
                    .whereIn('id', ids)
                    .update({ status: 'running', picked_at: now, updated_at: now });
            }
            return rows;
        });

        const commands = claimed.map((r) => {
            let name = null;
            let number = null;
            if (r.payload) {
                try {
                    const p = JSON.parse(r.payload);
                    if (p && typeof p === 'object') {
                        name = p.company_name != null ? p.company_name : null;
                        number = p.company_number != null ? p.company_number : null;
                    }
                } catch {
                    // Malformed payload → leave name/number null; the command id
                    // + type still reach the agent so it can fail-report it.
                }
            }
            return {
                id: r.id,
                type: r.type,
                company_id: r.company_id,
                company_name: name,
                company_number: number,
            };
        });

        return R.successResponse(res, { commands });
    } catch (err) {
        console.error('AgentController.getCommands error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /api/v1/agent/commands/:id/result   (authenticateAgent → req.license)
 * Body: { status:'done'|'failed', result?, error? }
 *
 * The agent reports a command's outcome. Scoped to a row owned by THIS agent's
 * license (so an agent can never close another license's command). Unknown
 * status values are coerced to 'failed' so a row never gets stuck in 'running'.
 */
async function commandResult(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return R.errorResponse(res, 'Invalid command id.', 422);
        }
        const status = (req.body && req.body.status) === 'done' ? 'done' : 'failed';
        const result = req.body && req.body.result != null ? String(req.body.result) : null;
        const error  = req.body && req.body.error  != null ? String(req.body.error)  : null;

        const updated = await db('agent_commands')
            .where({ id, license_id: req.license.id })
            .update({ status, result, error, updated_at: new Date() });

        if (!updated) {
            return R.errorResponse(res, 'Command not found.', 404);
        }
        return R.successResponse(res, undefined, 'ok');
    } catch (err) {
        console.error('AgentController.commandResult error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * GET /api/v1/agent/version   (authenticateAgent → req.license)
 *
 * Tells the agent what the published-latest exe is so it can decide whether to
 * self-update. Source of truth = the single agent_releases row with
 * is_current=true (a super-admin publishes it). Falls back to the env
 * AGENT_LATEST_VERSION (or null) when nothing is published yet.
 *
 * Response data:
 *   { latest_version, current, download_url, sha256, mandatory, notes,
 *     auto_update }
 *   • latest_version — the published version string (or null = nothing to do)
 *   • current        — true when the agent's reported version already matches
 *                      latest (so it need not download)
 *   • download_url   — relative path the agent GETs the exe from
 *   • mandatory      — a security release the agent applies even if auto_update is OFF
 *   • auto_update    — the per-LICENSE cloud toggle (Requirement 3). The agent
 *                      treats this as the authoritative on/off when present.
 *
 * Never throws to the client — any error returns a safe "nothing to update"
 * shape so a release-table hiccup can NEVER brick a working agent.
 */
async function getVersion(req, res) {
    try {
        // The agent reports its installed version via ?agent_version= (or header);
        // used only to compute the convenience `current` flag.
        const installed = String((req.query && req.query.agent_version) || '').trim();

        let rel = null;
        try {
            rel = await agentRelease.currentRelease(db);
        } catch (e) {
            rel = null;   // table missing / DB hiccup → behave as "no release".
        }

        const latestVersion = rel ? rel.version
            : (String(process.env.AGENT_LATEST_VERSION || '').trim() || null);

        // Per-license cloud toggle (default ON when the column/row is unreadable).
        let autoUpdate = true;
        try {
            const lic = await db('licenses').where('id', req.license.id).first('auto_update');
            if (lic && lic.auto_update != null) autoUpdate = !!lic.auto_update;
        } catch (e) {
            autoUpdate = true;
        }

        return R.successResponse(res, {
            latest_version: latestVersion,
            current: !!(latestVersion && installed && installed === latestVersion),
            download_url: '/api/v1/agent/download',
            sha256: rel ? (rel.sha256 || null) : null,
            mandatory: rel ? !!rel.mandatory : false,
            notes: rel ? (rel.notes || null) : null,
            auto_update: autoUpdate,
        }, 'ok');
    } catch (err) {
        console.error('AgentController.getVersion error:', err);
        // Safe fallback — never let this crash the agent's update check.
        return R.successResponse(res, {
            latest_version: null, current: true, download_url: '/api/v1/agent/download',
            sha256: null, mandatory: false, notes: null, auto_update: true,
        }, 'ok');
    }
}

/**
 * GET /api/v1/agent/download   (authenticateAgent → req.license)
 *
 * Streams the CURRENT release exe from AGENT_RELEASE_DIR/<filename>. 404 (in the
 * envelope) when there is no current release or the file is missing on disk.
 * The path is built from path.basename(stored filename) only (see
 * agentRelease.resolveFile), so a crafted filename can never path-traverse.
 */
async function download(req, res) {
    try {
        const rel = await agentRelease.currentRelease(db);
        if (!rel || !rel.filename) {
            return R.errorResponse(res, 'No agent release is currently published.', 404);
        }
        const filePath = agentRelease.resolveFile(rel.filename);
        if (!filePath) {
            return R.errorResponse(res, 'Release file name is invalid.', 404);
        }

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            return R.errorResponse(res, 'Release file not found on the server.', 404);
        }
        if (!stat.isFile()) {
            return R.errorResponse(res, 'Release file not found on the server.', 404);
        }

        const downloadName = path.basename(rel.filename);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        if (rel.sha256) res.setHeader('X-Agent-Sha256', String(rel.sha256));
        res.setHeader('X-Agent-Version', String(rel.version || ''));

        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => {
            console.error('AgentController.download stream error:', e);
            // Headers may already be sent (binary streaming); just tear down.
            if (!res.headersSent) {
                return R.errorResponse(res, 'Could not read the release file.', 500);
            }
            res.destroy(e);
        });
        return stream.pipe(res);
    } catch (err) {
        console.error('AgentController.download error:', err);
        if (!res.headersSent) {
            return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
        }
        return res.end();
    }
}

module.exports = { activate, heartbeat, offline, pending, result, importFromTally, getCommands, commandResult, getVersion, download };
