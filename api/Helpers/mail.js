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

const HOST      = (process.env.MAIL_HOST || '').trim();
const PORT      = parseInt(process.env.MAIL_PORT || '587', 10);
const USER      = process.env.MAIL_USERNAME || '';
const PASS      = process.env.MAIL_PASSWORD || '';
const FROM      = process.env.MAIL_FROM || USER;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Tally Cloud Sync';

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

/** Send an email. Returns the Nodemailer info, or {consoleOnly:true} in dev. */
async function sendMail({ to, subject, html, text }) {
    const t = getTransport();
    const from = `"${FROM_NAME}" <${FROM}>`;
    if (!t) {
        console.log(`\n[mail:console] (MAIL_HOST not set — not actually sent)\n  to: ${to}\n  subject: ${subject}\n  ${text || ''}\n`);
        return { consoleOnly: true };
    }
    return t.sendMail({ from, to, subject, html, text });
}

/** Branded password-reset code email. */
async function sendPasswordResetCode(to, code, name) {
    const subject = 'Your Tally Cloud Sync password reset code';
    const text =
        `Hi ${name || 'there'},\n\n` +
        `Your password reset code is: ${code}\n` +
        `This code expires in 15 minutes.\n\n` +
        `If you didn't request a password reset, you can safely ignore this email.\n\n` +
        `— Tally Cloud Sync`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2937">
      <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(16,24,40,.12)">
        <div style="background:linear-gradient(135deg,#2563EB,#6D28D9);padding:20px 24px;color:#fff;font-weight:700;font-size:17px">☁ Tally Cloud Sync</div>
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

module.exports = { sendMail, sendPasswordResetCode, getTransport };
