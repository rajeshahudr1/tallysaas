'use strict';

/**
 * api/jobs/reminderScheduler.js
 *
 * The AUTOMATIC payment-reminder job. For every licence whose Super-Admin turned
 * ON auto reminders (and at least one channel), at that licence's configured
 * hour, it nudges customers whose OLDEST overdue invoice is exactly one of the
 * licence's offset-days old (e.g. due+1, +7, +15).
 *
 * Channel per send: WhatsApp when enabled + the customer has a mobile, else
 * Email when enabled + the customer has an email. De-duplicated to at most ONE
 * auto reminder per customer per day (so a restart / the 30-min tick can't spam).
 *
 * No cron dependency — a 30-minute setInterval self-filters by send_hour.
 */

const db = require('../config/db').db;
const { overdueCustomers, reminderText, normalizeOffsets } = require('../Helpers/reminders');
const { sendPaymentReminder } = require('../Helpers/mail');
const { sendWhatsApp }        = require('../Helpers/whatsapp');

/** Has this customer already had an auto reminder today (any channel)? */
async function alreadySentToday(companyId, customerId, asOf) {
    const start = new Date(asOf);
    start.setHours(0, 0, 0, 0);
    const row = await db('payment_reminders')
        .where({ company_id: companyId, customer_id: customerId, trigger: 'auto' })
        .where('sent_at', '>=', start)
        .first('id');
    return !!row;
}

/** Run one pass. Safe to call repeatedly — it only acts for licences whose
 * send_hour matches the current hour, and de-dupes per customer per day. */
async function sendAutoReminders(asOf = new Date()) {
    const hour = asOf.getHours();
    const licences = await db('reminder_settings')
        .where('auto_enabled', true)
        .where('send_hour', hour)
        .where(function () { this.where('email_enabled', true).orWhere('whatsapp_enabled', true); })
        .select('license_id', 'email_enabled', 'whatsapp_enabled', 'offsets');

    const summary = { licences: licences.length, sent: 0, skipped: 0, failed: 0 };

    for (const lic of licences) {
        const offsets = normalizeOffsets(lic.offsets);
        if (!offsets.length) continue;

        const companies = await db('companies')
            .where('license_id', lic.license_id).whereNull('deleted_at')
            .select('id', 'name');

        for (const co of companies) {
            const overdue = await overdueCustomers(co.id, asOf);
            for (const cust of overdue) {
                // Only nudge on the EXACT offset day (due+1, +7, +15 …).
                if (!offsets.includes(cust.days_overdue)) continue;
                if (await alreadySentToday(co.id, cust.id, asOf)) { summary.skipped++; continue; }

                // Prefer WhatsApp, fall back to Email — only channels this licence allows.
                let channel = null, to = null;
                if (lic.whatsapp_enabled && cust.mobile) { channel = 'whatsapp'; to = cust.mobile; }
                else if (lic.email_enabled && cust.email) { channel = 'email'; to = cust.email; }
                if (!channel) { summary.skipped++; continue; }

                const text = reminderText({
                    customerName: cust.name, companyName: co.name,
                    outstanding: cust.outstanding, oldestDue: cust.oldest_due, overdueCount: cust.overdue_count,
                });

                let status = 'sent', error = null;
                try {
                    if (channel === 'email') {
                        await sendPaymentReminder(to, {
                            customerName: cust.name, companyName: co.name,
                            outstanding: cust.outstanding, oldestDue: cust.oldest_due, overdueCount: cust.overdue_count, text,
                        });
                    } else {
                        await sendWhatsApp(to, text);
                    }
                    summary.sent++;
                } catch (e) {
                    status = 'failed';
                    error = (e && e.message) || 'send failed';
                    summary.failed++;
                }

                await db('payment_reminders').insert({
                    company_id: co.id, customer_id: cust.id, channel, to_address: to,
                    amount: cust.outstanding, trigger: 'auto', offset_day: cust.days_overdue, status, error,
                });
            }
        }
    }
    return summary;
}

let _timer = null;

/** Start the 30-minute tick (idempotent). */
function startScheduler() {
    if (_timer) return;
    const tick = () => {
        sendAutoReminders()
            .then((r) => { if (r.sent || r.failed) console.log('[reminder-scheduler]', JSON.stringify(r)); })
            .catch((e) => console.error('[reminder-scheduler] error:', e && e.message));
    };
    _timer = setInterval(tick, 30 * 60 * 1000);
    if (_timer.unref) _timer.unref();   // don't hold the process open on shutdown
    console.log('[reminder-scheduler] started (30-min tick; sends at each licence\'s hour)');
}

module.exports = { sendAutoReminders, startScheduler };
