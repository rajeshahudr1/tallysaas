'use strict';

/**
 * api/jobs/einvoiceScheduler.js
 *
 * Background maintenance for the e-Invoice / e-Way module (no cron dependency —
 * a 5-minute setInterval). Two jobs run each tick:
 *
 *   1) EXPIRY SCAN — mark any e-Way Bill whose ewb_valid_until has passed as
 *      'expired' so the dashboard's "Expiry" / list status is truthful.
 *
 *   2) TIMEOUT RECONCILE — NIC frequently generates the IRN even when the client
 *      request TIMES OUT, leaving the row stuck in irp_status='generating'. For
 *      any row stuck > 5 min, re-query the IRP by document details (getIrnByDoc)
 *      and either stamp the recovered IRN or mark it 'failed' so it can be
 *      retried. Works in MOCK mode too (deterministic getIrnByDoc).
 *
 * All best-effort: one bad row never stops the tick, and the timer is unref'd so
 * it never holds the process open on shutdown.
 */

const db = require('../config/db').db;
const { resolveProvider } = require('../Modules/einvoice/providers/ProviderFactory');

const STUCK_MINUTES = 5;
const TICK_MS = 5 * 60 * 1000;

/** Mark e-Ways past their validity as expired. Returns the count updated. */
async function expireOverdueEways() {
    try {
        return await db('einvoices')
            .whereNotNull('ewb_valid_until')
            .where('ewb_status', 'generated')
            .where('ewb_valid_until', '<', db.fn.now())
            .whereNull('deleted_at')
            .update({ ewb_status: 'expired', updated_at: db.fn.now() });
    } catch (e) {
        console.error('[einvoice-scheduler] expire error:', e && e.message);
        return 0;
    }
}

/** Reconcile rows stuck in 'generating' (a timed-out generate that likely
 *  succeeded IRP-side). Returns the count recovered. */
async function reconcileStuck() {
    let recovered = 0;
    let stuck = [];
    try {
        stuck = await db('einvoices')
            .where('irp_status', 'generating')
            .whereNull('deleted_at')
            .where('updated_at', '<', db.raw(`now() - interval '${STUCK_MINUTES} minutes'`))
            .limit(10);
    } catch (e) {
        console.error('[einvoice-scheduler] stuck query error:', e && e.message);
        return 0;
    }

    for (const ei of stuck) {
        try {
            const payload = typeof ei.payload === 'string' ? JSON.parse(ei.payload) : (ei.payload || {});
            const doc = payload.DocDtls || {};
            const co = await db('companies').where('id', ei.company_id).first('license_id');
            const provider = await resolveProvider({
                licenseId: co && co.license_id, companyId: ei.company_id, gstin: ei.gstin, log: () => {},
            });
            const r = await provider.getIrnByDoc({ docType: doc.Typ, docNo: doc.No, docDate: doc.Dt });
            if (r && r.status === 'generated' && r.irn) {
                await db('einvoices').where('id', ei.id).update({
                    irn: r.irn, irp_status: 'generated', status: 'generated',
                    generated_at: db.fn.now(), error: null, updated_at: db.fn.now(),
                });
                recovered++;
            } else {
                await db('einvoices').where('id', ei.id).update({
                    irp_status: 'failed', error: 'Reconcile: IRN not found at the IRP.',
                    updated_at: db.fn.now(),
                });
            }
        } catch (e) {
            // Leave the row for the next tick — never let one bad row stop the loop.
            console.error('[einvoice-scheduler] reconcile row error:', e && e.message);
        }
    }
    return recovered;
}

/** One maintenance tick. Returns a summary for logging. */
async function runTick() {
    const expired = await expireOverdueEways();
    const reconciled = await reconcileStuck();
    return { expired, reconciled };
}

let _timer = null;

/** Start the 5-minute tick (idempotent). */
function startScheduler() {
    if (_timer) return;
    const tick = () => {
        runTick()
            .then((r) => { if (r.expired || r.reconciled) console.log('[einvoice-scheduler]', JSON.stringify(r)); })
            .catch((e) => console.error('[einvoice-scheduler] tick error:', e && e.message));
    };
    _timer = setInterval(tick, TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[einvoice-scheduler] started (5-min tick: e-Way expiry + IRN timeout reconcile)');
}

module.exports = { runTick, expireOverdueEways, reconcileStuck, startScheduler };
