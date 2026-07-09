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

    // ── Masters ──────────────────────────────────────────────────────────────
    customers: {
        title: 'Customers',
        intro: 'The parties you sell to (Sundry Debtors / ledgers in Tally). Every sales invoice and receipt is against a customer.',
        points: [
            'Store name, GST/PAN, contact, billing/shipping address, credit limit, and opening balance.',
            'Assign a customer to a Location (beat) and a Sales Person for field-sales scoping.',
            'Their outstanding = invoices − receipts; overdue ones drive Payment Reminders.',
            'Syncs both ways with Tally, so the master stays identical to your books.',
        ],
    },
    suppliers: {
        title: 'Suppliers',
        intro: 'The parties you buy from (Sundry Creditors in Tally). Every purchase invoice and payment is against a supplier.',
        points: [
            'Store name, GST/PAN, contact, address and opening balance.',
            'Your payable = purchase invoices − payments made to them.',
            'Used on purchase invoices + payment vouchers; syncs both ways with Tally.',
        ],
    },
    products: {
        title: 'Products',
        intro: 'Your stock items / services (Stock Items in Tally) — what you sell and hold in inventory.',
        points: [
            'Store name, SKU, HSN/SAC, GST rate, unit, purchase & sales price, and opening stock.',
            'Picked on invoice lines — HSN, rate and GST auto-fill from here.',
            'Drives Inventory (opening + purchased − sold = current stock).',
            'You can add multiple product images (kept in the cloud only, NOT synced to Tally).',
        ],
    },
    categories: {
        title: 'Categories',
        intro: 'Groups for your products (Stock Groups in Tally) — e.g. Footwear, Electronics.',
        points: [
            'Assign a category to each product to organise the catalogue.',
            'Used to filter Products & Inventory and to group items in reports.',
            'Syncs with Tally stock groups.',
        ],
    },
    locations: {
        title: 'Locations',
        intro: 'Your branches / godowns (where stock is held or business is done). They scope data per branch.',
        points: [
            'A user tied to a location sees only that location\'s data; no location = the whole company.',
            'Assign locations to a salesman as their "beats"; customers belong to a location.',
            'Maps to Tally godowns for stock tracking.',
        ],
    },
    'sales-persons': {
        title: 'Sales Persons',
        intro: 'Your field staff (salesmen). Link a login so they can create invoices on the road, scoped to what you assign them.',
        points: [
            'Assign each salesman their Locations (beats) and Customers.',
            'Their invoices go through the Approval queue before counting / syncing to Tally.',
            'They see only their own data — assigned customers, their invoices, their sales total.',
            'Field Tracking logs their visits + GPS.',
        ],
    },
    companies: {
        title: 'Companies',
        intro: 'The Tally companies under your licence. Each has its own customers, invoices, stock and books.',
        points: [
            'Switch the active company from the top bar — every page then shows that company\'s data.',
            'A company is created automatically when its Tally data first syncs from the desktop Agent.',
            'Your plan sets how many companies you can run.',
        ],
    },

    // ── Transactions ─────────────────────────────────────────────────────────
    'sales-invoices': {
        title: 'Sales Invoices',
        intro: 'What you bill your customers. Add line items and GST is computed for you; approved invoices sync to Tally.',
        points: [
            'Pick a customer, add product lines — HSN, rate, GST auto-fill; totals compute live.',
            'A salesman\'s invoice is Submitted for Approval; a company-admin approves → it counts + syncs to Tally.',
            'The Sales Register shows month-wise totals; drill into a month for its vouchers.',
            'Generate its e-Invoice / e-Way Bill, print/PDF, or record a Receipt against it.',
        ],
    },
    'purchase-invoices': {
        title: 'Purchase Invoices',
        intro: 'What your suppliers bill you (incoming bills). Mirrors sales invoices but on the buying side.',
        points: [
            'Pick a supplier, add product lines with GST — it increases stock + your payable.',
            'The Purchase Register shows month-wise totals with a month drill-down.',
            'Settle it by recording a Payment to the supplier.',
        ],
    },
    payments: {
        title: 'Payments',
        intro: 'Money going OUT — what you pay to suppliers or for expenses (payment vouchers in Tally).',
        points: [
            'Record who was paid, how much, the mode (cash/bank) and date.',
            'A supplier payment reduces what you owe them.',
            'Syncs to Tally as a payment voucher.',
        ],
    },
    receipts: {
        title: 'Receipts',
        intro: 'Money coming IN — what customers pay you (receipt vouchers in Tally).',
        points: [
            'Record which customer paid, how much, the mode and date.',
            'It reduces that customer\'s outstanding and clears them off Payment Reminders once settled.',
            'Syncs to Tally as a receipt voucher.',
        ],
    },
    journals: {
        title: 'Journals',
        intro: 'Adjustment entries that aren\'t cash in/out — e.g. write-offs, provisions, inter-ledger transfers (journal vouchers in Tally).',
        points: [
            'A double-entry: equal debit and credit across two ledgers.',
            'Use for corrections and non-cash accounting entries.',
            'Syncs to Tally as a journal voucher.',
        ],
    },
    inventory: {
        title: 'Inventory',
        intro: 'Your live stock position per product: opening + purchased − sold = current stock, with its value.',
        points: [
            'See current stock, stock value, and low-stock / out-of-stock counts at a glance.',
            'Filter by category, location, stock status or unit.',
            '"Stock Adjustment" manually corrects a product\'s quantity (needs edit rights).',
            'Numbers are derived from your invoices + opening stock.',
        ],
    },

    // ── Reports / others ─────────────────────────────────────────────────────
    reports: {
        title: 'Reports & Analytics',
        intro: 'Read-only business insights pulled to match Tally exactly — no editing, just answers.',
        points: [
            'Sales trend, cash flow, receivables aging, top customers/products, and headline KPIs.',
            'Figures come from your synced vouchers, so they tie to Tally to the paisa.',
            'Use them to spot overdue money, best sellers and slow months.',
        ],
    },
    expenses: {
        title: 'Expenses',
        intro: 'Record day-to-day business expenses (rent, salaries, utilities…) by category.',
        points: [
            'Log the amount, category, date and a note.',
            'Group by category to see where money goes.',
            'Feeds the cash-flow view in Analytics.',
        ],
    },
    users: {
        title: 'Users & Roles',
        intro: 'Your company logins and what each one is allowed to do (role-based permissions).',
        points: [
            'Create a role, tick which modules it can view / add / edit / delete, then assign it to users.',
            'A user only sees the menus + buttons their role grants — enforced on the server too.',
            'The super-admin decides which MODULES your licence has; you build roles from those.',
        ],
    },
    'accountant-access': {
        title: 'Accountant Access',
        intro: 'Invite your CA / accountant to view your books online — no need to email files or share your Tally.',
        points: [
            'Send an invite with a role that decides what they can see (usually read-only reports & vouchers).',
            'They log in with their own credentials — you can show / reset their password anytime.',
            'Revoke access in one tap; they drop off the list immediately.',
        ],
    },
    settings: {
        title: 'Settings',
        intro: 'Company-wide preferences: invoice numbering, tax defaults, print/branding, and which modules push to Tally.',
        points: [
            'Set your default GST behaviour, invoice prefixes and print header/logo.',
            'Choose which modules auto-sync with the Tally desktop Agent.',
            'Changes apply to the whole company, so only admins can edit them.',
        ],
    },
};

module.exports = { MODULE_INFO };
