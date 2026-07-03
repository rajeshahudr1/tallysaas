'use strict';

/**
 * api/jobs/recurringInvoiceScheduler.js
 *
 * Hourly pass that generates any due recurring invoices (next_run_date <= today,
 * Active). Idempotent — generating advances next_run_date past today, so a
 * re-run does nothing. Runs once ~30s after boot to catch startup-due templates.
 */

const { runDueRecurring } = require('../Helpers/recurringInvoices');
const { forEachTenant } = require('../Helpers/eachTenant');

let _timer = null;

function startScheduler() {
    if (_timer) return;
    // Per-license multi-DB: recurring_invoices (+ the invoices it generates) live
    // in each tenant db, so run the due-pass once per tenant with that db bound as
    // `db` (runDueRecurring uses the ALS-bound db). One tenant's failure is logged
    // and skipped by forEachTenant — it never aborts the others.
    const tick = () => {
        forEachTenant(async (licenseId) => {
            const r = await runDueRecurring();
            if (r && r.generated) console.log(`[recurring-scheduler] lic=${licenseId}`, JSON.stringify(r));
        }).catch((e) => console.error('[recurring-scheduler] error:', e && e.message));
    };
    _timer = setInterval(tick, 60 * 60 * 1000);   // hourly
    if (_timer.unref) _timer.unref();
    const boot = setTimeout(tick, 30 * 1000);      // one catch-up shortly after boot
    if (boot.unref) boot.unref();
    console.log('[recurring-scheduler] started (hourly)');
}

module.exports = { startScheduler };
