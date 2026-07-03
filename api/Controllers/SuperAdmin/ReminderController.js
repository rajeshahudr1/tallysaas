'use strict';

/**
 * api/Controllers/SuperAdmin/ReminderController.js
 *
 * Super-Admin control of a licence's payment-reminder channels + auto schedule.
 * A licence's companies can send Email / WhatsApp reminders ONLY when the
 * platform admin switches them on here. The SMTP / WhatsApp credentials live in
 * the API .env — this only flips per-licence entitlement + the schedule.
 *
 *   get    GET /super-admin/licenses/:id/reminders
 *   update PUT /super-admin/licenses/:id/reminders
 *          { email_enabled, whatsapp_enabled, auto_enabled, offsets, send_hour }
 */

const R = require('../../Helpers/response');
const db = require('../../config/db').db;
const masterDb = require('../../config/masterDb').db;   // licenses live in the master control plane
const { getSettings, saveSettings } = require('../../Helpers/reminders');
const { isConfigured: waConfigured } = require('../../Helpers/whatsapp');
const { getTransport } = require('../../Helpers/mail');

const OOPS = 'Oops..Something went wrong. Please try again.';

async function licenseExists(id) {
    if (!Number.isInteger(id) || id <= 0) return false;
    const row = await masterDb('licenses').where('id', id).whereNull('deleted_at').first('id');
    return !!row;
}

async function get(req, res) {
    try {
        const id = Number(req.params.id);
        if (!(await licenseExists(id))) return R.errorResponse(res, 'License not found.', 404);
        const settings = await getSettings(id);
        // Surface whether the platform even has creds wired, so the UI can warn
        // "enabled but not configured".
        return R.successResponse(res, {
            ...settings,
            email_configured: !!getTransport(),
            whatsapp_configured: waConfigured(),
        });
    } catch (err) {
        console.error('reminders.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function update(req, res) {
    try {
        const id = Number(req.params.id);
        if (!(await licenseExists(id))) return R.errorResponse(res, 'License not found.', 404);
        const b = req.body || {};
        const settings = await saveSettings(id, {
            email_enabled:    b.email_enabled,
            whatsapp_enabled: b.whatsapp_enabled,
            auto_enabled:     b.auto_enabled,
            offsets:          b.offsets,
            send_hour:        b.send_hour,
        });
        return R.successResponse(res, settings, 'Reminder settings saved.');
    } catch (err) {
        console.error('reminders.update error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { get, update };
