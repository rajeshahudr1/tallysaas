'use strict';

/**
 * api/jobs/reminderScheduler.js
 *
 * Two kinds of reminder run here:
 *   • the licence-wide auto reminder (fixed hour + offset days), and
 *   • per-party schedules set through "Set Reminder", which OVERRIDE the
 *     licence offsets for the parties that have one, so a customer is never
 *     chased twice on the same day.
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
const { dueNow, pickChannel } = require('../Helpers/reminderSchedule');
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
    const { forEachTenant } = require('../Helpers/eachTenant');
    const summary = { licences: 0, sent: 0, skipped: 0, failed: 0 };

    // Per-license multi-DB: reminder_settings + companies + payment_reminders all
    // live in each tenant db, so run once per tenant with that db bound as `db`.
    await forEachTenant(async () => {
        const lic = await db('reminder_settings')
            .where('auto_enabled', true)
            .where('send_hour', hour)
            .where(function () { this.where('email_enabled', true).orWhere('whatsapp_enabled', true); })
            .first('email_enabled', 'whatsapp_enabled', 'offsets');
        if (!lic) return;
        summary.licences++;

        const offsets = normalizeOffsets(lic.offsets);
        if (!offsets.length) return;

        const companies = await db('companies')
            .whereNull('deleted_at')
            .select('id', 'name');

        for (const co of companies) {
            const overdue = await overdueCustomers(co.id, asOf);

            // Per-party schedules ("Set Reminder") OVERRIDE the licence-wide
            // offsets for the parties that have one — otherwise a customer with
            // a daily schedule would also get chased on the licence's offset
            // days, i.e. twice.
            const scheduleRows = await db('customer_reminder_schedules')
                .where('company_id', co.id).select('*');
            const scheduleOf = new Map(scheduleRows.map((r) => [Number(r.customer_id), r]));

            for (const cust of overdue) {
                const own = scheduleOf.get(Number(cust.id));
                if (own) {
                    if (!dueNow(own, asOf, cust)) { summary.skipped++; continue; }
                } else if (!offsets.includes(cust.days_overdue)) {
                    // Licence-wide behaviour: only on the EXACT offset day.
                    continue;
                }
                if (await alreadySentToday(co.id, cust.id, asOf)) { summary.skipped++; continue; }

                // A party's own schedule picks the channel; otherwise prefer
                // WhatsApp and fall back to Email. Either way the licence's
                // Super-Admin switches still have the final say.
                const own2 = scheduleOf.get(Number(cust.id));
                let channel = own2 ? pickChannel(own2.channel, cust) : null;
                if (!channel) {
                    if (cust.mobile) channel = 'whatsapp';
                    else if (cust.email) channel = 'email';
                }
                if (channel === 'whatsapp' && !(lic.whatsapp_enabled && cust.mobile)) {
                    channel = (lic.email_enabled && cust.email) ? 'email' : null;
                }
                if (channel === 'email' && !(lic.email_enabled && cust.email)) {
                    channel = (lic.whatsapp_enabled && cust.mobile) ? 'whatsapp' : null;
                }
                if (!channel) { summary.skipped++; continue; }
                const to = channel === 'whatsapp' ? cust.mobile : cust.email;

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
                    amount: cust.outstanding,
                    trigger: scheduleOf.has(Number(cust.id)) ? 'schedule' : 'auto',
                    offset_day: cust.days_overdue, status, error,
                });
            }
        }
    });
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
