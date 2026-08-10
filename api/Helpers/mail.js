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
const L     = require('./emailLayout');

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
    const html = L.wrap({
        title: 'Reset your password',
        body: `<p style="margin:0 0 6px">Hi ${name || 'there'},</p>
               <p style="margin:0 0 18px">Enter this code to set a new password. It expires in <b>15 minutes</b>.</p>
               ${L.codeBlock(code)}
               ${L.note("Didn't request this? You can safely ignore this email — your password stays unchanged.")}`,
        footer: `Questions? Reply to this email or write to <a href="mailto:${BRAND.supportEmail}" style="color:${L.COLORS.muted}">${BRAND.supportEmail}</a>.`,
    });
    return sendMail({ to, subject, html, text, attachments: L.logoAttachment() });
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
    const html = L.wrap({
        title: 'Connect this computer',
        body: `<p style="margin:0 0 6px">Hi ${name || 'there'},</p>
               <p style="margin:0 0 18px">Enter this code in the ${BRAND.name} agent to connect this computer${where ? `<b>${where}</b>` : ''} to your account. It expires in <b>10 minutes</b>.</p>
               ${L.codeBlock(code)}
               ${L.note('If you did not start this, do <b>not</b> share the code — change your password instead. This code lets a computer read your books.')}`,
        footer: `Questions? Reply to this email or write to <a href="mailto:${BRAND.supportEmail}" style="color:${L.COLORS.muted}">${BRAND.supportEmail}</a>.`,
    });
    return sendMail({ to, subject, html, text, attachments: L.logoAttachment() });
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
    const html = L.wrap({
        title: `${company} shared their books with you`,
        body: `<p style="margin:0 0 6px">Hi ${name || 'there'},</p>
               <p style="margin:0 0 16px">You have <b>read-only</b> access — view and export their reports, ledgers, invoices and outstanding. Nothing you do can change their data.</p>
               ${L.panel(
                   `<div style="margin-bottom:4px"><span style="color:${L.COLORS.muted}">Email</span><br><b>${email}</b></div>
                    <div><span style="color:${L.COLORS.muted}">Password</span><br><b style="font-family:Consolas,Menlo,'Courier New',monospace">${password}</b></div>`
               )}
               ${L.button('Sign in', loginUrl)}
               ${L.note("Please change your password after signing in. If you weren't expecting this, you can ignore this email.")}`,
        footer: `Questions? Reply to this email or write to <a href="mailto:${BRAND.supportEmail}" style="color:${L.COLORS.muted}">${BRAND.supportEmail}</a>.`,
    });
    return sendMail({ to, subject, html, text, attachments: L.logoAttachment() });
}

/** Branded payment-reminder email to an overdue customer. `text` is the shared
 * plain-text body (from reminders.reminderText); the HTML is a nicer version. */
async function sendPaymentReminder(to, { customerName, companyName, outstanding, oldestDue, overdueCount, text } = {}) {
    const money = '₹' + Number(outstanding || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // "11 Jun 2026", not en-IN's "11/6/2026". A dunning email is read by people
    // who also get d/m and m/d dates all day; a spelled month cannot be misread
    // as a different date, and the recipient is being asked to act on this one.
    const due = oldestDue
        ? new Date(oldestDue).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
    const brand = companyName || BRAND.name;
    const subject = `Payment reminder — ${brand}`;
    // NO Teloora logo here, and no logo attachment: this email is sent BY our
    // customer's business TO their customer. Our branding on it would put a
    // stranger's name on their dunning letter. The business's own name is the
    // header; we appear only in the small "sent via" line, which also explains
    // the unfamiliar sending domain to the recipient.
    const html = L.wrap({
        heading: brand,
        title: 'Payment reminder',
        body: `<p style="margin:0 0 6px">Dear ${customerName || 'Customer'},</p>
               <p style="margin:0 0 14px">This is a gentle reminder that your account shows an outstanding balance of:</p>
               <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 4px">
                 <tr><td align="center" style="background:${L.COLORS.panel};border:1px solid ${L.COLORS.hair};border-radius:12px;padding:18px 12px">
                   <div style="font:800 28px/1.2 Segoe UI,Helvetica,Arial,sans-serif;color:${L.COLORS.ink}">${money}</div>
                   ${overdueCount ? `<div style="margin-top:6px;font:400 13px/1.5 Segoe UI,Helvetica,Arial,sans-serif;color:${L.COLORS.muted}">${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'}${due ? ` &middot; oldest due ${due}` : ''}</div>` : ''}
                 </td></tr>
               </table>
               <p style="margin:16px 0 0">Kindly arrange the payment at your earliest convenience.</p>
               ${L.note('If you have already paid, please ignore this email.')}`,
        footer: `Sent by ${brand} via ${BRAND.name}`,
    });
    return sendMail({ to, subject, html, text });
}

module.exports = { sendMail, sendPasswordResetCode, sendAgentLoginCode, sendAccountantInvite, sendPaymentReminder, getTransport };
