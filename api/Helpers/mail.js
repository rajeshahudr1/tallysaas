'use strict';

/**
 * api/Helpers/mail.js
 *
 * Thin Nodemailer wrapper. Reads SMTP config from the MAIL_* env vars:
 *   MAIL_HOST, MAIL_PORT, MAIL_USERNAME, MAIL_PASSWORD, MAIL_ENCRYPTION,
 *   MAIL_FROM, MAIL_FROM_NAME
 *
 * If MAIL_HOST is blank, emails are LOGGED to the console instead of sent —
 * handy in dev so the reset code is still visible without a live SMTP server.
 *
 * Port 465 → implicit TLS (secure:true); 587/others → STARTTLS (secure:false).
 */

const nodemailer = require('nodemailer');
const BRAND = require('../config/brand');

const HOST      = (process.env.MAIL_HOST || '').trim();
const PORT      = parseInt(process.env.MAIL_PORT || '587', 10);
const USER      = process.env.MAIL_USERNAME || '';
const PASS      = process.env.MAIL_PASSWORD || '';
const FROM      = process.env.MAIL_FROM || USER;
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND.name;

let _transport = null;
function getTransport() {
    if (!HOST) return null;                 // console-only mode
    if (!_transport) {
        _transport = nodemailer.createTransport({
            host: HOST,
            port: PORT,
            secure: PORT === 465,           // 465 = implicit TLS
            auth: USER ? { user: USER, pass: PASS } : undefined,
        });
    }
    return _transport;
}

/** Send an email. Returns the Nodemailer info, or {consoleOnly:true} in dev.
 *  `attachments` is passed straight through to Nodemailer (e.g. a PDF buffer:
 *  [{ filename, content: <Buffer>, contentType: 'application/pdf' }]). */
async function sendMail({ to, subject, html, text, attachments }) {
    const t = getTransport();
    const from = `"${FROM_NAME}" <${FROM}>`;
    if (!t) {
        const att = Array.isArray(attachments) && attachments.length
            ? ` (+${attachments.length} attachment${attachments.length === 1 ? '' : 's'}: ${attachments.map((a) => a.filename).join(', ')})` : '';
        console.log(`\n[mail:console] (MAIL_HOST not set — not actually sent)\n  to: ${to}\n  subject: ${subject}${att}\n  ${text || ''}\n`);
        return { consoleOnly: true };
    }
    return t.sendMail({ from, to, subject, html, text, attachments });
}

/** Branded password-reset code email. */
async function sendPasswordResetCode(to, code, name) {
    const subject = `Your ${BRAND.name} password reset code`;
    const text =
        `Hi ${name || 'there'},\n\n` +
        `Your password reset code is: ${code}\n` +
        `This code expires in 15 minutes.\n\n` +
        `If you didn't request a password reset, you can safely ignore this email.\n\n` +
        `— ${BRAND.name}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2937">
      <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(16,24,40,.12)">
        <div style="background:${BRAND.colors.gradient};padding:20px 24px;color:#fff;font-weight:700;font-size:17px">${BRAND.name} · ${BRAND.tagline}</div>
        <div style="padding:26px 24px">
          <p style="margin:0 0 6px;font-size:15px">Hi ${name || 'there'},</p>
          <p style="margin:0 0 18px;color:#6b7280;font-size:13.5px">Use this code to reset your password. It expires in <b>15 minutes</b>.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#111827;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;text-align:center;padding:16px 0">${code}</div>
          <p style="margin:18px 0 0;color:#9ca3af;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      </div>
    </body></html>`;
    return sendMail({ to, subject, html, text });
}

/**
 * The 6-digit code that connects a computer to the account.
 *
 * Deliberately says WHICH machine is being connected and what to do if it was
 * not them. A code email with no context is indistinguishable from a phishing
 * attempt, and this one authorises a machine to read the entire book — so the
 * recipient needs enough to recognise an activation they did not start.
 */
async function sendAgentLoginCode(to, code, name, machineName) {
    const where = machineName ? ` on "${machineName}"` : '';
    const subject = `Your ${BRAND.name} connection code`;
    const text =
        `Hi ${name || 'there'},\n\n` +
        `Your code to connect this computer${where} is: ${code}\n` +
        `It expires in 10 minutes.\n\n` +
        `If you did not start this, do NOT share the code. Change your password.\n\n` +
        `— ${BRAND.name}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2937">
      <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(16,24,40,.12)">
        <div style="background:${BRAND.colors.gradient};padding:20px 24px;color:#fff;font-weight:700;font-size:17px">${BRAND.name} · ${BRAND.tagline}</div>
        <div style="padding:26px 24px">
          <p style="margin:0 0 6px;font-size:15px">Hi ${name || 'there'},</p>
          <p style="margin:0 0 18px;color:#6b7280;font-size:13.5px">Use this code to connect this computer${where ? `<b>${where}</b>` : ''} to your account. It expires in <b>10 minutes</b>.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#111827;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;text-align:center;padding:16px 0">${code}</div>
          <p style="margin:18px 0 0;color:#9ca3af;font-size:12px">If you did not start this, do not share this code — change your password instead.</p>
        </div>
      </div>
    </body></html>`;
    return sendMail({ to, subject, html, text });
}

/** Branded "you've been invited as an Accountant" email — sent in the BACKGROUND
 * when a company shares its books with a CA. Carries the sign-in email + the
 * password the company set, and a note that access is read-only. */
async function sendAccountantInvite(to, { name, companyName, email, password } = {}) {
    const loginUrl = (process.env.WEB_URL || process.env.WEB_ORIGIN || '').trim();
    const company = companyName || 'A business';
    const subject = `${company} has invited you to ${BRAND.name}`;
    const linkText = loginUrl ? `Sign in at ${loginUrl}\n` : `Sign in to your ${BRAND.name} account\n`;
    const text =
        `Hi ${name || 'there'},\n\n` +
        `${company} has shared their books with you on ${BRAND.name}. You have ` +
        `READ-ONLY access — you can view & export their reports, ledgers, invoices ` +
        `and outstanding, but cannot change anything.\n\n` +
        linkText +
        `  Email:    ${email}\n` +
        `  Password: ${password}\n\n` +
        `Please change your password after signing in.\n\n— ${BRAND.name}`;
    const btn = loginUrl
        ? `<a href="${loginUrl}" style="display:inline-block;margin:6px 0 4px;background:${BRAND.colors.gradient};color:#fff;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:10px">Sign in</a>`
        : '';
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2937">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(16,24,40,.12)">
        <div style="background:${BRAND.colors.gradient};padding:20px 24px;color:#fff;font-weight:700;font-size:17px">${BRAND.name} · ${BRAND.tagline}</div>
        <div style="padding:26px 24px">
          <p style="margin:0 0 6px;font-size:15px">Hi ${name || 'there'},</p>
          <p style="margin:0 0 16px;color:#6b7280;font-size:13.5px"><b>${company}</b> has shared their books with you. You have <b>read-only</b> access — you can <b>view &amp; export</b> reports, ledgers, invoices and outstanding, but cannot change anything.</p>
          <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:0 0 16px;font-size:14px">
            <div style="margin-bottom:6px"><span style="color:#9ca3af">Email:</span> <b>${email}</b></div>
            <div><span style="color:#9ca3af">Password:</span> <b>${password}</b></div>
          </div>
          ${btn}
          <p style="margin:18px 0 0;color:#9ca3af;font-size:12px">Please change your password after signing in. If you didn't expect this, you can ignore this email.</p>
        </div>
      </div>
    </body></html>`;
    return sendMail({ to, subject, html, text });
}

/** Branded payment-reminder email to an overdue customer. `text` is the shared
 * plain-text body (from reminders.reminderText); the HTML is a nicer version. */
async function sendPaymentReminder(to, { customerName, companyName, outstanding, oldestDue, overdueCount, text } = {}) {
    const money = '₹' + Number(outstanding || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const due = oldestDue ? new Date(oldestDue).toLocaleDateString('en-IN') : '';
    const brand = companyName || BRAND.name;
    const subject = `Payment reminder — ${brand}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2937">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(16,24,40,.12)">
        <div style="background:linear-gradient(135deg,#2563EB,#6D28D9);padding:20px 24px;color:#fff;font-weight:700;font-size:17px">${brand}</div>
        <div style="padding:26px 24px">
          <p style="margin:0 0 6px;font-size:15px">Dear ${customerName || 'Customer'},</p>
          <p style="margin:0 0 14px;color:#6b7280;font-size:13.5px">This is a gentle payment reminder. Your account currently shows an outstanding balance of:</p>
          <div style="font-size:26px;font-weight:800;color:#111827;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;text-align:center;padding:16px 0">${money}</div>
          ${overdueCount ? `<p style="margin:14px 0 0;color:#6b7280;font-size:13px">${overdueCount} overdue invoice(s)${due ? ` &middot; oldest due ${due}` : ''}</p>` : ''}
          <p style="margin:16px 0 0;color:#6b7280;font-size:13.5px">Kindly arrange the payment at your earliest convenience.</p>
          <p style="margin:14px 0 0;color:#9ca3af;font-size:12px">If you have already paid, please ignore this email.</p>
        </div>
      </div>
    </body></html>`;
    return sendMail({ to, subject, html, text });
}

module.exports = { sendMail, sendPasswordResetCode, sendAgentLoginCode, sendAccountantInvite, sendPaymentReminder, getTransport };
