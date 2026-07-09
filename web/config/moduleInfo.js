'use strict';

/**
 * web/config/moduleInfo.js
 *
 * Short, plain-English "how this module works" blurbs shown behind the ⓘ info
 * icon on each module's LIST page (page-head). Keep the app's copy
 * (app/lib/core/module_info.dart) in sync — same keys, same wording.
 *
 * Shape: key → { title, intro, points:[…] }. Add one entry per module, one at a
 * time — do NOT try to cover every module at once.
 */

const MODULE_INFO = {
    recurring: {
        title: 'Recurring Invoices',
        intro: 'A template that auto-creates a repeating sales invoice on a schedule — so you never re-type a bill that repeats (rent, AMC, subscriptions).',
        points: [
            'Make a template: customer, amount + GST, frequency (Monthly / Quarterly / Yearly), start date, and "Due in (days)".',
            'It auto-generates a REAL sales invoice each period — the hourly scheduler does it for you.',
            '"Generate now" cuts the NEXT period\'s invoice each click (Jul, then Aug, then Sep…), and stops at the End Date.',
            'Due date = invoice date + "Due in (days)". The bill settles when you record a Receipt against it.',
            'Use "View" (eye) on a template to see the schedule + every invoice it has generated.',
        ],
    },
    einvoice: {
        title: 'e-Invoice & e-Way Bill',
        intro: 'Creates the GST-portal documents for a sales invoice: the e-Invoice (IRN + signed QR) and, for goods movement, the e-Way Bill.',
        points: [
            'e-Invoice = an Invoice Reference Number (IRN) + QR the government issues for a B2B invoice; mandatory above the GST turnover limit.',
            'e-Way Bill = the transport document required when moving goods above the value threshold.',
            'Generate against an approved invoice; you can also cancel (within the allowed window) or enter one manually.',
            'Needs your GST portal / GSP credentials configured by the super-admin first — otherwise it stays in draft.',
            'The e-Invoice Dashboard tracks which invoices have an IRN / e-Way and their status.',
        ],
    },
    reminders: {
        title: 'Payment Reminders',
        intro: 'Automatically chases customers who have OVERDUE, unpaid invoices — nudging them to pay by Email or WhatsApp.',
        points: [
            'A customer appears when they have a sales invoice past its due date with a positive outstanding balance.',
            'Automatic: at your set send-hour the scheduler nudges customers whose oldest overdue invoice hits a reminder day-mark (e.g. 7 / 15 / 30 days) — at most one per customer per day.',
            'Manual: click "Send" on any overdue customer and pick Email or WhatsApp — it goes out now.',
            'WhatsApp is used when enabled + the customer has a mobile; otherwise Email. Every send is logged.',
            'The super-admin enables the Email / WhatsApp channels for your licence; record a Receipt to clear a customer off the list.',
        ],
    },
    'bank-reconciliation': {
        title: 'Bank Reconciliation',
        intro: 'Matches your bank statement against the receipts & payments in your books, so you can confirm every entry actually hit the bank.',
        points: [
            'Import your bank statement as a CSV — each line becomes a bank transaction (credit or debit).',
            'Auto-match tries to pair each line to a voucher: a CREDIT to a Receipt, a DEBIT to a Payment, by amount within ±3 days.',
            'Anything not auto-matched shows candidate vouchers so you can match it manually (or mark it as a bank-only entry).',
            'Once matched, the entry is "reconciled" — your closing balance ties to the bank.',
            'It never changes Tally data — it only links your existing vouchers to bank lines.',
        ],
    },
};

module.exports = { MODULE_INFO };
