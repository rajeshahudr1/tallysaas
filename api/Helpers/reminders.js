'use strict';

/**
 * api/Helpers/reminders.js
 *
 * Read/write a licence's payment-reminder settings (the Super-Admin switches)
 * and expose which channels a company may actually use. A company can send a
 * channel ONLY when its licence has it enabled here — so this is the single
 * gate the tenant side checks before sending.
 */

const db = require('../config/db').db;

const DEFAULTS = { email_enabled: false, whatsapp_enabled: false, auto_enabled: false, offsets: [1, 7, 15], send_hour: 10 };

/** Coerce the stored jsonb (or a stray string) into a clean sorted int array. */
function normalizeOffsets(v) {
    let arr = v;
    if (typeof v === 'string') {
        try { arr = JSON.parse(v); }               // '[1,7,15]' or a lone '7'
        catch (_) { arr = v.split(','); }          // '1, 7, 15' from a text field
    }
    if (typeof arr === 'number') arr = [arr];      // JSON.parse('7') → 7 → [7]
    if (!Array.isArray(arr)) arr = [];
    const cleaned = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))];
    return cleaned.sort((a, b) => a - b).slice(0, 12);
}

/** A licence's settings, filled with safe defaults when no row exists yet. */
async function getSettings(licenseId) {
    if (!licenseId) return { license_id: null, ...DEFAULTS };
    const row = await db('reminder_settings').where('license_id', licenseId).first();
    if (!row) return { license_id: licenseId, ...DEFAULTS };
    return {
        license_id: licenseId,
        email_enabled: !!row.email_enabled,
        whatsapp_enabled: !!row.whatsapp_enabled,
        auto_enabled: !!row.auto_enabled,
        offsets: normalizeOffsets(row.offsets),
        send_hour: row.send_hour,
    };
}

/** Upsert a licence's settings; returns the fresh normalized settings. */
async function saveSettings(licenseId, patch = {}) {
    const row = {
        license_id: licenseId,
        email_enabled: !!patch.email_enabled,
        whatsapp_enabled: !!patch.whatsapp_enabled,
        auto_enabled: !!patch.auto_enabled,
        offsets: JSON.stringify(normalizeOffsets(patch.offsets)),
        send_hour: Math.min(23, Math.max(0, parseInt(patch.send_hour, 10) || 10)),
        updated_at: new Date(),
    };
    const existing = await db('reminder_settings').where('license_id', licenseId).first('id');
    if (existing) {
        await db('reminder_settings').where('license_id', licenseId).update(row);
    } else {
        await db('reminder_settings').insert({ ...row, created_at: new Date() });
    }
    return getSettings(licenseId);
}

/** ₹ formatted with Indian grouping. */
function formatMoney(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Customers of a company who are OVERDUE — i.e. have at least one sales invoice
 * past its due_date AND a positive outstanding balance. Outstanding is computed
 * self-contained (receipts aren't invoice-linked in this schema):
 *   outstanding = opening_balance + Σ(sales invoice totals) − Σ(receipt amounts)
 * Returned newest-pain-first (most days overdue on top).
 */
async function overdueCustomers(companyId, asOf = new Date()) {
    const today = asOf.toISOString().slice(0, 10);
    const rows = await db('customers as c')
        .where('c.company_id', companyId)
        .whereNull('c.deleted_at')
        .select(
            'c.id', 'c.name', 'c.email', 'c.mobile', 'c.opening_balance',
            db.raw("coalesce((select sum(i.total) from invoices i where i.customer_id = c.id and i.type = 'sales' and i.deleted_at is null), 0) as sales_total"),
            db.raw("coalesce((select sum(p.amount) from payments p where p.customer_id = c.id and p.type = 'receipt' and p.deleted_at is null), 0) as receipts_total"),
            db.raw("(select count(*) from invoices i where i.customer_id = c.id and i.type = 'sales' and i.deleted_at is null and i.due_date is not null and i.due_date < ?) as overdue_count", [today]),
            db.raw("(select min(i.due_date) from invoices i where i.customer_id = c.id and i.type = 'sales' and i.deleted_at is null and i.due_date is not null and i.due_date < ?) as oldest_due", [today]),
        );
    return rows
        .map((r) => {
            const outstanding = Number(r.opening_balance) + Number(r.sales_total) - Number(r.receipts_total);
            const oldest = r.oldest_due ? new Date(r.oldest_due) : null;
            const daysOverdue = oldest ? Math.max(0, Math.floor((asOf - oldest) / 86400000)) : 0;
            return {
                id: r.id,
                name: r.name,
                email: r.email || '',
                mobile: r.mobile || '',
                outstanding: Math.round(outstanding * 100) / 100,
                overdue_count: Number(r.overdue_count) || 0,
                oldest_due: r.oldest_due || null,
                days_overdue: daysOverdue,
            };
        })
        .filter((r) => r.overdue_count > 0 && r.outstanding > 0.5)
        .sort((a, b) => b.days_overdue - a.days_overdue);
}

/** Plain-text reminder body (WhatsApp + the text part of the email). */
function reminderText({ customerName, companyName, outstanding, oldestDue, overdueCount }) {
    const due = oldestDue ? new Date(oldestDue).toLocaleDateString('en-IN') : '';
    return `Dear ${customerName || 'Customer'},\n\n` +
        `This is a gentle payment reminder from ${companyName || 'us'}. Your account currently shows an ` +
        `outstanding balance of ${formatMoney(outstanding)}` +
        (overdueCount ? ` with ${overdueCount} overdue invoice(s)${due ? ` (oldest due ${due})` : ''}` : '') + `.\n\n` +
        `Kindly arrange the payment at your earliest convenience. If you have already paid, please ignore this message.\n\n` +
        `Thank you,\n${companyName || ''}`;
}

module.exports = {
    getSettings, saveSettings, normalizeOffsets, DEFAULTS,
    overdueCustomers, reminderText, formatMoney,
};
