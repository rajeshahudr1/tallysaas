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

const R          = require('../../Helpers/response');
const jwt        = require('../../Helpers/jwt');
const licenseKey = require('../../Helpers/licenseKey');
const db         = require('../../config/db').db;

const AGENT_TOKEN_TTL = '7d';
const INVALID_KEY_MSG = 'Invalid license key.';

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

        // Companies this license may sync.
        const companies = await db('companies')
            .where('license_id', lic.id)
            .whereNull('deleted_at')
            .select('id', 'name', 'slug', 'status')
            .orderBy('id', 'asc');

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
 */
async function heartbeat(req, res) {
    try {
        const now = new Date();
        await db('licenses').where('id', req.license.id).update({
            last_seen_at: now,
            agent_version: (req.body && req.body.agent_version) || undefined,
            updated_at: now,
        });
        return R.successResponse(res, {
            status: req.license.status,
            license_id: req.license.id,
            server_time: now.toISOString(),
        }, 'ok');
    } catch (err) {
        console.error('AgentController.heartbeat error:', err);
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
        const companies = await db('companies')
            .where('license_id', req.license.id).whereNull('deleted_at')
            .select('id', 'name', 'slug');
        const companyIds = companies.map((c) => c.id);
        if (!companyIds.length) {
            return R.successResponse(res, { ledgers: [], stock_items: [], vouchers: [], companies: [] });
        }

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
            ledgers, stock_items,
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
        const companyIds = (await db('companies')
            .where('license_id', req.license.id).whereNull('deleted_at').pluck('id'));
        const allowed = new Set(companyIds.map(Number));

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
 * Tally → Cloud PULL: the agent reads masters from the open Tally company and
 * sends them here to be upserted into the cloud. Body:
 *   { company_id, ledgers:[{name,parent}], stock_items:[{name,closing}] }
 * Ledgers are classified by their Tally parent group — "Sundry Debtors" →
 * customers, "Sundry Creditors" → suppliers (system ledgers like Cash / P&L are
 * skipped). Matching is by name (company-scoped, case-insensitive): an existing
 * record is just LINKED (tally_guid set); a new name is INSERTED. Stock items →
 * products. Every import writes a direction:'pull' tally_sync_logs row.
 */
async function importFromTally(req, res) {
    try {
        const companyIds = await db('companies')
            .where('license_id', req.license.id).whereNull('deleted_at').pluck('id');
        const cid = Number(req.body && req.body.company_id);
        if (!new Set(companyIds.map(Number)).has(cid)) {
            return R.errorResponse(res, 'That company is not under this license.', 403);
        }

        const ledgers    = Array.isArray(req.body.ledgers) ? req.body.ledgers : [];
        const stockItems = Array.isArray(req.body.stock_items) ? req.body.stock_items : [];
        const vouchers   = Array.isArray(req.body.vouchers) ? req.body.vouchers : [];
        const now = new Date();
        const counts = { customers_new: 0, customers_linked: 0, suppliers_new: 0,
            suppliers_linked: 0, products_new: 0, products_linked: 0,
            vouchers_new: 0, skipped: 0 };

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

        for (const l of ledgers) {
            const name = String(l.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }
            const parent = String(l.parent || '').toLowerCase();
            const table = parent.includes('debtor') ? 'customers'
                        : parent.includes('creditor') ? 'suppliers' : null;
            if (!table) { counts.skipped += 1; continue; }   // skip Cash/Bank/P&L/etc.

            const existing = await db(table).where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id', 'tally_guid');
            if (existing) {
                // Already linked on a previous pull → idempotent no-op (no log spam).
                if (existing.tally_guid) { counts.skipped += 1; continue; }
                await db(table).where('id', existing.id).update({ tally_guid: 'tally', updated_at: now });
                counts[table === 'customers' ? 'customers_linked' : 'suppliers_linked'] += 1;
                await logPull(table === 'customers' ? 'customer' : 'supplier', existing.id, name);
            } else {
                const [row] = await db(table).insert({
                    company_id: cid, name, status: 'Active', is_tally_ledger: true,
                    tally_guid: 'tally', opening_balance: 0, created_at: now, updated_at: now,
                }).returning('id');
                counts[table === 'customers' ? 'customers_new' : 'suppliers_new'] += 1;
                await logPull(table === 'customers' ? 'customer' : 'supplier', row.id || row, name);
            }
        }

        for (const s of stockItems) {
            const name = String(s.name || '').trim();
            if (!name) { counts.skipped += 1; continue; }
            const closing = parseFloat(String(s.closing || '').replace(/[^0-9.\-]/g, '')) || 0;
            const existing = await db('products').where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id', 'tally_guid');
            if (existing) {
                if (existing.tally_guid) { counts.skipped += 1; continue; }
                await db('products').where('id', existing.id).update({ tally_guid: 'tally', updated_at: now });
                counts.products_linked += 1;
                await logPull('product', existing.id, name);
            } else {
                const [row] = await db('products').insert({
                    company_id: cid, name, status: 'Active', is_tally_item: true, tally_guid: 'tally',
                    unit: 'Nos', opening_stock: closing, purchase_price: 0, sales_price: 0,
                    gst_rate: 0, created_at: now, updated_at: now,
                }).returning('id');
                counts.products_new += 1;
                await logPull('product', row.id || row, name);
            }
        }

        // ── Vouchers (Day Book): receipts/payments → payments, sales/purchase
        //    → invoices (header only). Party matched by name; unmatched (e.g.
        //    Cash contra) skipped. Idempotent via tally_voucher_no. ──
        for (const v of vouchers) {
            const vt = String(v.vtype || '').toLowerCase();
            const vno = String(v.vno || '').trim();
            const amount = Number(v.amount) || 0;
            const date = tdate(v.date);
            const partyName = String(v.party || '').trim();
            if (!amount || !partyName) { counts.skipped += 1; continue; }

            const isReceipt = vt.indexOf('receipt') > -1;
            const isPayment = vt.indexOf('payment') > -1;
            const isSales = vt.indexOf('sales') > -1;
            const isPurchase = vt.indexOf('purchase') > -1;
            if (!isReceipt && !isPayment && !isSales && !isPurchase) { counts.skipped += 1; continue; }

            // Resolve the party to a customer (receipt/sales) or supplier (payment/purchase).
            const partyTable = (isReceipt || isSales) ? 'customers' : 'suppliers';
            const party = await db(partyTable).where('company_id', cid).whereNull('deleted_at')
                .whereRaw('lower(name) = ?', [partyName.toLowerCase()]).first('id');
            if (!party) { counts.skipped += 1; continue; }   // unmatched party (e.g. Cash)

            if (isReceipt || isPayment) {
                const type = isReceipt ? 'receipt' : 'payment';
                const dup = await db('payments').where({ company_id: cid, type, tally_voucher_no: vno })
                    .whereNull('deleted_at').first('id');
                if (dup || !vno) { counts.skipped += 1; continue; }
                await db('payments').insert({
                    company_id: cid, type, voucher_no: vno, payment_date: date,
                    amount, mode: 'Cash', status: 'created', tally_voucher_no: vno,
                    [isReceipt ? 'customer_id' : 'supplier_id']: party.id,
                    created_at: now, updated_at: now,
                });
            } else {
                const type = isSales ? 'sales' : 'purchase';
                const dup = await db('invoices').where({ company_id: cid, type, tally_voucher_no: vno })
                    .whereNull('deleted_at').first('id');
                if (dup || !vno) { counts.skipped += 1; continue; }
                await db('invoices').insert({
                    company_id: cid, type, invoice_no: vno, invoice_date: date,
                    [isSales ? 'customer_id' : 'supplier_id']: party.id,
                    taxable: amount, cgst: 0, sgst: 0, igst: 0, tax_amount: 0, total: amount,
                    status: 'created', tally_voucher_no: vno, created_at: now, updated_at: now,
                });
            }
            counts.vouchers_new += 1;
            await logPull(isReceipt ? 'receipt' : isPayment ? 'payment' : isSales ? 'sales_invoice' : 'purchase_invoice', null, `${v.vtype} ${vno}`);
        }

        return R.successResponse(res, counts, 'Imported from Tally.');
    } catch (err) {
        console.error('AgentController.importFromTally error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { activate, heartbeat, pending, result, importFromTally };
