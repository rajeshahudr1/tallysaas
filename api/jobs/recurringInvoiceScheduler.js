'use strict';

/**
 * api/jobs/recurringInvoiceScheduler.js
 *
 * Hourly pass that generates any due recurring invoices (next_run_date <= today,
 * Active). Idempotent — generating advances next_run_date past today, so a
 * re-run does nothing. Runs once ~30s after boot to catch startup-due templates.
 */

const { runDueRecurring } = require('../Helpers/recurringInvoices');

let _timer = null;

function startScheduler() {
    if (_timer) return;
    const tick = () => {
        runDueRecurring()
            .then((r) => { if (r.generated) console.log('[recurring-scheduler]', JSON.stringify(r)); })
            .catch((e) => console.error('[recurring-scheduler] error:', e && e.message));
    };
    _timer = setInterval(tick, 60 * 60 * 1000);   // hourly
    if (_timer.unref) _timer.unref();
    const boot = setTimeout(tick, 30 * 1000);      // one catch-up shortly after boot
    if (boot.unref) boot.unref();
    console.log('[recurring-scheduler] started (hourly)');
}

module.exports = { startScheduler };
