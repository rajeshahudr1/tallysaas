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
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const { getSettings, overdueCustomers, reminderText } = require('../../Helpers/reminders');
const { sendPaymentReminder } = require('../../Helpers/mail');
const { sendWhatsApp }        = require('../../Helpers/whatsapp');

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

module.exports = { overdue, send };
