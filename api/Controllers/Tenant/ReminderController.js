'use strict';

/**
 * api/Controllers/Tenant/ReminderController.js
 *
 * Company-facing payment reminders.
 *
 *   overdue GET  /account/reminders
 *           → overdue customers (past-due sales invoice + positive outstanding)
 *             plus which channels this licence is ALLOWED to use.
 *   send    POST /account/reminders/:id/send   { channel: 'email' | 'whatsapp' }
 *           → send one reminder now (manual). Gated by the licence's Super-Admin
 *             switches; overdue re-checked server-side; every send is logged.
 *   schedule    GET  /account/reminders/:id/schedule
 *   saveSchedule PUT /account/reminders/:id/schedule
 *           → the PER-PARTY reminder schedule ("Set Reminder"). A party with a
 *             schedule is chased on ITS terms; parties without one keep the
 *             licence-wide auto reminder. Channels are Email / WhatsApp only —
 *             there is no SMS gateway in this product.
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const { getSettings, overdueCustomers, reminderText } = require('../../Helpers/reminders');
const { sendPaymentReminder } = require('../../Helpers/mail');
const { sendWhatsApp }        = require('../../Helpers/whatsapp');
const { normalizeSchedule, FREQUENCIES, CHANNELS } = require('../../Helpers/reminderSchedule');

const OOPS = 'Oops..Something went wrong. Please try again.';

async function overdue(req, res) {
    try {
        const companyId = req.companyId;
        const licenseId = (req.user && req.user.license_id) || null;
        const [rows, settings] = await Promise.all([
            overdueCustomers(companyId),
            getSettings(licenseId),
        ]);
        return R.successResponse(res, {
            data: rows,
            channels: { email: settings.email_enabled, whatsapp: settings.whatsapp_enabled },
            total_outstanding: Math.round(rows.reduce((s, r) => s + r.outstanding, 0) * 100) / 100,
        });
    } catch (err) {
        console.error('reminders.overdue error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * The company's own reminder wording, when they have customised it on the
 * Payment Reminders screen. Stored in the flat settings bag rather than a
 * column of its own — it is one piece of text per company, which is exactly
 * what that bag is for.
 */
async function reminderTemplate(companyId) {
    const row = await db('settings')
        .where({ company_id: companyId, key: 'reminder_template' })
        .first('value');
    return (row && row.value) || '';
}

/**
 * Send ONE reminder and record it. Returns { ok, error } rather than
 * throwing, so a bulk run can report per-party outcomes instead of dying on
 * the first party with no email address.
 *
 * Every caller goes through here, so the entitlement check, the overdue
 * re-verification and the audit row can never be skipped by a new entry
 * point — which is the whole reason bulk did not just loop over the HTTP
 * handler.
 */
async function sendOne({ companyId, userId, customer, channel, companyName, template }) {
    const to = channel === 'email' ? customer.email : customer.mobile;
    if (!to) {
        return { ok: false, error: channel === 'email'
            ? 'No email address on file.' : 'No mobile number on file.' };
    }
    const text = reminderText({
        customerName: customer.name, companyName,
        outstanding: customer.outstanding, oldestDue: customer.oldest_due,
        overdueCount: customer.overdue_count, template,
    });

    let status = 'sent', error = null;
    try {
        if (channel === 'email') {
            await sendPaymentReminder(to, {
                customerName: customer.name, companyName,
                outstanding: customer.outstanding, oldestDue: customer.oldest_due,
                overdueCount: customer.overdue_count, text,
            });
        } else {
            await sendWhatsApp(to, text);
        }
    } catch (e) {
        status = 'failed';
        error = (e && e.message) || 'send failed';
    }

    await db('payment_reminders').insert({
        company_id: companyId, customer_id: customer.id, channel, to_address: to,
        amount: customer.outstanding, trigger: 'manual', status, error,
        sent_by: userId || null,
    });
    return { ok: status === 'sent', error };
}

/**
 * Is this channel switched on for the caller's licence? Returns an error
 * message, or null when allowed.
 */
function channelBlocked(settings, channel) {
    if (channel === 'email' && !settings.email_enabled) {
        return 'Email reminders are not enabled on your plan. Please contact the administrator.';
    }
    if (channel === 'whatsapp' && !settings.whatsapp_enabled) {
        return 'WhatsApp reminders are not enabled on your plan. Please contact the administrator.';
    }
    return null;
}

async function send(req, res) {
    try {
        const companyId  = req.companyId;
        const licenseId  = (req.user && req.user.license_id) || null;
        const customerId = Number(req.params.id);
        const channel    = String((req.body && req.body.channel) || 'email').toLowerCase();
        if (!['email', 'whatsapp'].includes(channel)) return R.errorResponse(res, 'Invalid channel.', 422);

        const settings = await getSettings(licenseId);
        const blocked = channelBlocked(settings, channel);
        if (blocked) return R.errorResponse(res, blocked, 403);

        // Re-verify the customer is genuinely overdue — never trust the client.
        const cust = (await overdueCustomers(companyId)).find((c) => c.id === customerId);
        if (!cust) return R.errorResponse(res, 'This customer is not overdue (or the balance is already settled).', 422);

        const company = await db('companies').where('id', companyId).first('name');
        const companyName = (company && company.name) || '';
        const template = await reminderTemplate(companyId);
        const result = await sendOne({
            companyId, userId: req.user ? req.user.sub : null,
            customer: cust, channel, companyName, template,
        });

        if (!result.ok) return R.errorResponse(res, 'Could not send the reminder: ' + result.error, 502);
        return R.successResponse(res, { channel, to: channel === 'email' ? cust.email : cust.mobile },
            `Reminder sent to ${cust.name} via ${channel === 'email' ? 'Email' : 'WhatsApp'}.`);
    } catch (err) {
        console.error('reminders.send error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * POST /account/reminders/send-bulk — chase several parties at once.
 *
 * body: { channel, customer_ids: [] }. An EMPTY list means "everyone
 * overdue" — that is the button most people press, and making them tick 200
 * boxes to do it is not a safety feature.
 *
 * Sends are sequential, not parallel: a mail relay that is happy with one
 * message a second will rate-limit (or blacklist) two hundred at once, and a
 * bulk run that gets the account throttled is worse than a slow one.
 */
async function sendBulk(req, res) {
    try {
        const companyId = req.companyId;
        const licenseId = (req.user && req.user.license_id) || null;
        const channel   = String((req.body && req.body.channel) || 'email').toLowerCase();
        if (!['email', 'whatsapp'].includes(channel)) return R.errorResponse(res, 'Invalid channel.', 422);

        const settings = await getSettings(licenseId);
        const blocked = channelBlocked(settings, channel);
        if (blocked) return R.errorResponse(res, blocked, 403);

        const asked = Array.isArray(req.body && req.body.customer_ids)
            ? req.body.customer_ids.map(Number).filter((n) => Number.isInteger(n))
            : [];
        // The overdue list is the source of truth for WHO may be chased; the
        // request only narrows it. A hand-posted id for a settled party can
        // therefore never produce a reminder.
        let targets = await overdueCustomers(companyId);
        if (asked.length) {
            const wanted = new Set(asked);
            targets = targets.filter((c) => wanted.has(c.id));
        }
        if (!targets.length) return R.errorResponse(res, 'No overdue parties to remind.', 422);

        const company = await db('companies').where('id', companyId).first('name');
        const companyName = (company && company.name) || '';
        const template = await reminderTemplate(companyId);

        let sent = 0;
        const failed = [];
        for (const cust of targets) {
            // eslint-disable-next-line no-await-in-loop
            const r = await sendOne({
                companyId, userId: req.user ? req.user.sub : null,
                customer: cust, channel, companyName, template,
            });
            if (r.ok) sent += 1;
            else failed.push({ id: cust.id, name: cust.name, error: r.error });
        }

        // Reported as a success even with failures: the run DID happen, and
        // the per-party reasons are the useful part. A blanket error would
        // hide the ones that went out.
        return R.successResponse(res, { sent, failed, attempted: targets.length },
            failed.length
                ? `${sent} reminder(s) sent, ${failed.length} could not be sent.`
                : `${sent} reminder(s) sent.`);
    } catch (err) {
        console.error('reminders.sendBulk error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * GET /account/reminders/:id/schedule — one party's schedule plus the message
 * that would be sent, so the UI can show a live preview.
 */
async function schedule(req, res) {
    try {
        const companyId  = req.companyId;
        const licenseId  = (req.user && req.user.license_id) || null;
        const customerId = Number(req.params.id);
        if (!Number.isInteger(customerId) || customerId < 1) {
            return R.errorResponse(res, 'Customer not found.', 404);
        }

        const customer = await db('customers')
            .where({ company_id: companyId, id: customerId }).whereNull('deleted_at')
            .first('id', 'name', 'mobile', 'email');
        if (!customer) return R.errorResponse(res, 'Customer not found.', 404);

        const [row, settings, company, overdueRows] = await Promise.all([
            db('customer_reminder_schedules')
                .where({ company_id: companyId, customer_id: customerId }).first(),
            getSettings(licenseId),
            db('companies').where('id', companyId).first('name'),
            overdueCustomers(companyId),
        ]);

        const mine = overdueRows.find((r) => Number(r.id) === customerId) || null;

        return R.successResponse(res, {
            customer: {
                id: customer.id, name: customer.name,
                mobile: customer.mobile || '', email: customer.email || '',
            },
            // An absent row is a real state ("no schedule set"), so it comes back
            // disabled rather than as null — the UI renders one form either way.
            schedule: normalizeSchedule(row || { enabled: false }),
            options: { frequencies: FREQUENCIES, channels: CHANNELS },
            // The licence-level switches still gate what may actually be sent.
            allowed: { email: settings.email_enabled, whatsapp: settings.whatsapp_enabled },
            outstanding: mine ? mine.outstanding : 0,
            preview: reminderText({
                customerName: customer.name,
                companyName: (company && company.name) || '',
                outstanding: mine ? mine.outstanding : 0,
                oldestDue: mine ? mine.oldest_due : null,
                overdueCount: mine ? mine.overdue_count : 0,
            }),
        });
    } catch (err) {
        console.error('reminders.schedule error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/** PUT /account/reminders/:id/schedule — create or replace one party's schedule. */
async function saveSchedule(req, res) {
    try {
        const companyId  = req.companyId;
        const customerId = Number(req.params.id);
        if (!Number.isInteger(customerId) || customerId < 1) {
            return R.errorResponse(res, 'Customer not found.', 404);
        }

        const customer = await db('customers')
            .where({ company_id: companyId, id: customerId }).whereNull('deleted_at')
            .first('id');
        if (!customer) return R.errorResponse(res, 'Customer not found.', 404);

        // normalizeSchedule is the validator: anything unrecognised falls back
        // to a safe value, so a hand-posted body can never store junk.
        const s = normalizeSchedule(req.body);
        const row = {
            company_id: companyId, customer_id: customerId,
            enabled: s.enabled, channel: s.channel, frequency: s.frequency,
            send_hour: s.send_hour, weekday: s.weekday, day_of_month: s.day_of_month,
            created_by: (req.user && req.user.sub) || null,
            updated_at: new Date(),
        };

        await db('customer_reminder_schedules')
            .insert({ ...row, created_at: new Date() })
            .onConflict(['company_id', 'customer_id'])
            .merge({ ...row, created_by: undefined });

        return R.successResponse(res, { schedule: s });
    } catch (err) {
        console.error('reminders.saveSchedule error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { overdue, send, sendBulk, schedule, saveSchedule };
