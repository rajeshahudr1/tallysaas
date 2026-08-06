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

async function send(req, res) {
    try {
        const companyId  = req.companyId;
        const licenseId  = (req.user && req.user.license_id) || null;
        const customerId = Number(req.params.id);
        const channel    = String((req.body && req.body.channel) || 'email').toLowerCase();
        if (!['email', 'whatsapp'].includes(channel)) return R.errorResponse(res, 'Invalid channel.', 422);

        // Licence entitlement — a company can only use channels the Super-Admin
        // switched on for its licence.
        const settings = await getSettings(licenseId);
        if (channel === 'email' && !settings.email_enabled)
            return R.errorResponse(res, 'Email reminders are not enabled on your plan. Please contact the administrator.', 403);
        if (channel === 'whatsapp' && !settings.whatsapp_enabled)
            return R.errorResponse(res, 'WhatsApp reminders are not enabled on your plan. Please contact the administrator.', 403);

        // Re-verify the customer is genuinely overdue — never trust the client.
        const cust = (await overdueCustomers(companyId)).find((c) => c.id === customerId);
        if (!cust) return R.errorResponse(res, 'This customer is not overdue (or the balance is already settled).', 422);

        const to = channel === 'email' ? cust.email : cust.mobile;
        if (!to) {
            return R.errorResponse(res, channel === 'email'
                ? 'This customer has no email address on file.'
                : 'This customer has no mobile number on file.', 422);
        }

        const company = await db('companies').where('id', companyId).first('name');
        const companyName = (company && company.name) || '';
        const text = reminderText({
            customerName: cust.name, companyName,
            outstanding: cust.outstanding, oldestDue: cust.oldest_due, overdueCount: cust.overdue_count,
        });

        let status = 'sent', error = null;
        try {
            if (channel === 'email') {
                await sendPaymentReminder(to, {
                    customerName: cust.name, companyName,
                    outstanding: cust.outstanding, oldestDue: cust.oldest_due, overdueCount: cust.overdue_count, text,
                });
            } else {
                await sendWhatsApp(to, text);
            }
        } catch (e) {
            status = 'failed';
            error = (e && e.message) || 'send failed';
        }

        await db('payment_reminders').insert({
            company_id: companyId, customer_id: customerId, channel, to_address: to,
            amount: cust.outstanding, trigger: 'manual', status, error,
            sent_by: req.user ? req.user.sub : null,
        });

        if (status === 'failed') return R.errorResponse(res, 'Could not send the reminder: ' + error, 502);
        return R.successResponse(res, { channel, to },
            `Reminder sent to ${cust.name} via ${channel === 'email' ? 'Email' : 'WhatsApp'}.`);
    } catch (err) {
        console.error('reminders.send error:', err);
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

module.exports = { overdue, send, schedule, saveSchedule };
