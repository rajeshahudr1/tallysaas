import 'package:flutter/material.dart';

import '../app/theme.dart';

/// Short, plain-English "how this module works" blurbs shown behind the ⓘ info
/// icon on each module's list screen (AppBar). Keep in sync with the web copy
/// (web/config/moduleInfo.js) — same keys, same wording.
class ModuleInfo {
  const ModuleInfo(this.title, this.intro, this.points);
  final String title;
  final String intro;
  final List<String> points;
}

const Map<String, ModuleInfo> kModuleInfo = {
  'recurring': ModuleInfo(
    'Recurring Invoices',
    'A template that auto-creates a repeating sales invoice on a schedule — so you never re-type a bill that repeats (rent, AMC, subscriptions).',
    [
      'Make a template: customer, amount + GST, frequency (Monthly / Quarterly / Yearly), start date, and "Due in (days)".',
      'It auto-generates a REAL sales invoice each period — the hourly scheduler does it for you.',
      '"Generate now" cuts the NEXT period\'s invoice each tap (Jul, then Aug, then Sep…), and stops at the End Date.',
      'Due date = invoice date + "Due in (days)". The bill settles when you record a Receipt against it.',
      'Tap "View" on a template to see the schedule + every invoice it has generated.',
    ],
  ),
  'einvoice': ModuleInfo(
    'e-Invoice & e-Way Bill',
    'Creates the GST-portal documents for a sales invoice: the e-Invoice (IRN + signed QR) and, for goods movement, the e-Way Bill.',
    [
      'e-Invoice = an Invoice Reference Number (IRN) + QR the government issues for a B2B invoice; mandatory above the GST turnover limit.',
      'e-Way Bill = the transport document required when moving goods above the value threshold.',
      'Generate against an approved invoice; you can also cancel (within the allowed window) or enter one manually.',
      'Needs your GST portal / GSP credentials configured by the super-admin first — otherwise it stays in draft.',
      'The e-Invoice Dashboard tracks which invoices have an IRN / e-Way and their status.',
    ],
  ),
  'reminders': ModuleInfo(
    'Payment Reminders',
    'Automatically chases customers who have OVERDUE, unpaid invoices — nudging them to pay by Email or WhatsApp.',
    [
      'A customer appears when they have a sales invoice past its due date with a positive outstanding balance.',
      'Automatic: at your set send-hour the scheduler nudges customers whose oldest overdue invoice hits a reminder day-mark (e.g. 7 / 15 / 30 days) — at most one per customer per day.',
      'Manual: tap "Send" on any overdue customer and pick Email or WhatsApp — it goes out now.',
      'WhatsApp is used when enabled + the customer has a mobile; otherwise Email. Every send is logged.',
      'The super-admin enables the channels for your licence; record a Receipt to clear a customer off the list.',
    ],
  ),
  'bank-reconciliation': ModuleInfo(
    'Bank Reconciliation',
    'Matches your bank statement against the receipts & payments in your books, so you can confirm every entry actually hit the bank.',
    [
      'Import your bank statement as a CSV — each line becomes a bank transaction (credit or debit).',
      'Auto-match tries to pair each line to a voucher: a CREDIT to a Receipt, a DEBIT to a Payment, by amount within ±3 days.',
      'Anything not auto-matched shows candidate vouchers so you can match it manually.',
      'Once matched, the entry is "reconciled" — your closing balance ties to the bank.',
      'It never changes Tally data — it only links your existing vouchers to bank lines.',
    ],
  ),

  // ── Masters ──────────────────────────────────────────────────────────────
  'customers': ModuleInfo(
    'Customers',
    'The parties you sell to (Sundry Debtors / ledgers in Tally). Every sales invoice and receipt is against a customer.',
    [
      'Store name, GST/PAN, contact, billing/shipping address, credit limit, and opening balance.',
      'Assign a customer to a Location (beat) and a Sales Person for field-sales scoping.',
      'Their outstanding = invoices − receipts; overdue ones drive Payment Reminders.',
      'Syncs both ways with Tally, so the master stays identical to your books.',
    ],
  ),
  'suppliers': ModuleInfo(
    'Suppliers',
    'The parties you buy from (Sundry Creditors in Tally). Every purchase invoice and payment is against a supplier.',
    [
      'Store name, GST/PAN, contact, address and opening balance.',
      'Your payable = purchase invoices − payments made to them.',
      'Used on purchase invoices + payment vouchers; syncs both ways with Tally.',
    ],
  ),
  'products': ModuleInfo(
    'Products',
    'Your stock items / services (Stock Items in Tally) — what you sell and hold in inventory.',
    [
      'Store name, SKU, HSN/SAC, GST rate, unit, purchase & sales price, and opening stock.',
      'Picked on invoice lines — HSN, rate and GST auto-fill from here.',
      'Drives Inventory (opening + purchased − sold = current stock).',
      'You can add multiple product images (kept in the cloud only, NOT synced to Tally).',
    ],
  ),
  'categories': ModuleInfo(
    'Categories',
    'Groups for your products (Stock Groups in Tally) — e.g. Footwear, Electronics.',
    [
      'Assign a category to each product to organise the catalogue.',
      'Used to filter Products & Inventory and to group items in reports.',
      'Syncs with Tally stock groups.',
    ],
  ),
  'locations': ModuleInfo(
    'Locations',
    'Your branches / godowns (where stock is held or business is done). They scope data per branch.',
    [
      'A user tied to a location sees only that location\'s data; no location = the whole company.',
      'Assign locations to a salesman as their "beats"; customers belong to a location.',
      'Maps to Tally godowns for stock tracking.',
    ],
  ),
  'sales-persons': ModuleInfo(
    'Sales Persons',
    'Your field staff (salesmen). Link a login so they can create invoices on the road, scoped to what you assign them.',
    [
      'Assign each salesman their Locations (beats) and Customers.',
      'Their invoices go through the Approval queue before counting / syncing to Tally.',
      'They see only their own data — assigned customers, their invoices, their sales total.',
      'Field Tracking logs their visits + GPS.',
    ],
  ),
  'companies': ModuleInfo(
    'Companies',
    'The Tally companies under your licence. Each has its own customers, invoices, stock and books.',
    [
      'Switch the active company from the top bar — every page then shows that company\'s data.',
      'A company is created automatically when its Tally data first syncs from the desktop Agent.',
      'Your plan sets how many companies you can run.',
    ],
  ),

  // ── Transactions ─────────────────────────────────────────────────────────
  'quotations': ModuleInfo(
    'Quotations',
    'The price offer you send a customer BEFORE the sale — no stock moves and nothing is billed until it is accepted and converted.',
    [
      'Pick a customer, add item lines with rate + GST; totals compute on the server.',
      'A quote is Open until the customer answers — then mark it Accepted or Rejected.',
      'Past its "Valid till" date it shows as Expired automatically.',
      'Convert an accepted quote into a real Sales Invoice in one tap — the lines carry over.',
      'Share the PDF with the customer; nothing reaches Tally until the invoice is made.',
    ],
  ),
  'sales-orders': ModuleInfo(
    'Sales Orders',
    'A confirmed order from a customer — what they have agreed to buy, and when it must be delivered. Stock is not billed until you invoice it.',
    [
      'Pick a customer, add item lines, and set "Due On" — the date the goods are promised.',
      'Delivery progress shows as Pending → Partial → Delivered; cancel an order that falls through.',
      'Convert it into a Sales Invoice in one tap — the lines carry over.',
      'Use it to see committed demand before it becomes a bill.',
    ],
  ),
  'credit-notes': ModuleInfo(
    'Credit Notes',
    'A sales RETURN — goods (or value) coming back from a customer, reducing what they owe you.',
    [
      'Raise it against the original sales invoice so the reversal is traceable.',
      'Add the returned lines with quantity and rate; GST is reversed on the same items.',
      'It reduces what that customer owes you.',
      'Syncs to Tally as a Credit Note voucher.',
    ],
  ),
  'debit-notes': ModuleInfo(
    'Debit Notes',
    'A purchase RETURN — goods (or value) going back to a supplier, reducing what you owe them.',
    [
      'Raise it against the original supplier bill; record their bill number for reference.',
      'Add the returned lines with quantity and rate; GST is reversed on the same items.',
      'It reduces your payable to that supplier.',
      'Syncs to Tally as a Debit Note voucher.',
    ],
  ),
  'sales-invoices': ModuleInfo(
    'Sales Invoices',
    'What you bill your customers. Add line items and GST is computed for you; approved invoices sync to Tally.',
    [
      'Pick a customer, add product lines — HSN, rate, GST auto-fill; totals compute live.',
      'A salesman\'s invoice is Submitted for Approval; a company-admin approves → it counts + syncs to Tally.',
      'The Sales Register shows month-wise totals; drill into a month for its vouchers.',
      'Generate its e-Invoice / e-Way Bill, print/PDF, or record a Receipt against it.',
    ],
  ),
  'purchase-orders': ModuleInfo(
    'Purchase Orders',
    'What YOU have ordered from a supplier — the commitment you send them before their bill arrives.',
    [
      'Pick a supplier, add item lines, and set "Due On" — when the goods are expected.',
      'Progress shows as Pending → Partial → Delivered; cancel an order that is called off.',
      'Convert it into a Purchase Invoice once the supplier bills you — the lines carry over.',
      'Nothing hits stock or your payable until the invoice is made.',
    ],
  ),
  'purchase-invoices': ModuleInfo(
    'Purchase Invoices',
    'What your suppliers bill you (incoming bills). Mirrors sales invoices but on the buying side.',
    [
      'Pick a supplier, add product lines with GST — it increases stock + your payable.',
      'The Purchase Register shows month-wise totals with a month drill-down.',
      'Settle it by recording a Payment to the supplier.',
    ],
  ),
  'payments': ModuleInfo(
    'Payments',
    'Money going OUT — what you pay to suppliers or for expenses (payment vouchers in Tally).',
    [
      'Record who was paid, how much, the mode (cash/bank) and date.',
      'A supplier payment reduces what you owe them.',
      'Syncs to Tally as a payment voucher.',
    ],
  ),
  'receipts': ModuleInfo(
    'Receipts',
    'Money coming IN — what customers pay you (receipt vouchers in Tally).',
    [
      'Record which customer paid, how much, the mode and date.',
      'It reduces that customer\'s outstanding and clears them off Payment Reminders once settled.',
      'Syncs to Tally as a receipt voucher.',
    ],
  ),
  'journals': ModuleInfo(
    'Journals',
    'Adjustment entries that aren\'t cash in/out — e.g. write-offs, provisions, inter-ledger transfers (journal vouchers in Tally).',
    [
      'A double-entry: equal debit and credit across two ledgers.',
      'Use for corrections and non-cash accounting entries.',
      'Syncs to Tally as a journal voucher.',
    ],
  ),
  'delivery-notes': ModuleInfo(
    'Delivery Notes',
    'The challan that goes OUT with the goods — proof of what was dispatched, before the sales invoice is raised.',
    [
      'Pick the customer, add the items being sent, and set the dispatch date.',
      'Raise it against a Sales Order so the order can be delivered in parts.',
      'Convert it into a Sales Invoice once you bill for what was delivered.',
      'Pending until invoiced; cancel it if the dispatch is called off.',
    ],
  ),
  'receipt-notes': ModuleInfo(
    'Receipt Notes',
    'The record of goods COMING IN from a supplier — what actually arrived, before their bill is entered.',
    [
      'Pick the supplier, add the items received, and set the received date.',
      'Raise it against a Purchase Order so a part-delivery is tracked.',
      'Convert it into a Purchase Invoice when the supplier bills you.',
      'Pending until invoiced; cancel it if the goods are returned outright.',
    ],
  ),
  'my-vouchers': ModuleInfo(
    'My Vouchers',
    'Everything YOU created in this company — quotations, orders, notes, invoices, receipts, payments and journals in one list, newest first.',
    [
      'Only your own entries appear; what other users made is never shown here.',
      'The tag on each row says which voucher family it belongs to.',
      'Tap a row to open that voucher wherever the app has a screen for it.',
    ],
  ),
  'field-tracking': ModuleInfo(
    'Tracking Report',
    'Where your field staff actually went: the outlet visits logged that day and the GPS pings their phones sent in.',
    [
      'Pick a date, and a salesman when you want just one person.',
      'A visit shows check-in / check-out time and how far from the outlet it was recorded.',
      'The GPS icon says whether the check-in happened inside the outlet geofence.',
      'Tap any row to open that spot in your maps app.',
      'A salesman only ever sees their own rows — the API scopes it regardless of the filter.',
    ],
  ),
  'collect-payments': ModuleInfo(
    'Collect Payments',
    'Send a customer a payment link for an unpaid invoice — they pay you directly by UPI, with no gateway in between.',
    [
      'Pick an outstanding invoice; the amount is taken from the bill itself.',
      'Share the link — the customer sees your UPI QR and ID on a public page.',
      'When the money lands, tap "Mark paid" — that records the Receipt too.',
      'Cancel a request to stop its link working; nothing is written to the books.',
      'Set your UPI ID under settings first, or the link has nothing to pay into.',
    ],
  ),
  'cash-bank': ModuleInfo(
    'Cash & Bank',
    'Your cash and bank ledgers with their live balances for a period — replayed from the vouchers synced out of Tally.',
    [
      'Each row is one ledger; the amount is its closing balance and Dr/Cr says which side it sits on.',
      'Change the date range and every balance is recomputed for that period.',
      'Tap a ledger to see its statement: opening, every voucher that moved it, and closing.',
      'Read-only — money moves through Receipts, Payments and Contra vouchers.',
    ],
  ),
  'receivables': ModuleInfo(
    'Receivables',
    'What your customers still owe you — the debtor ledgers with their outstanding balances.',
    [
      'Each row is a customer ledger; the balance is what is still to be collected.',
      'Tap one to see every invoice and receipt that built that balance.',
      'Record a Receipt to bring a balance down.',
    ],
  ),
  'payables': ModuleInfo(
    'Payables',
    'What you still owe your suppliers — the creditor ledgers with their outstanding balances.',
    [
      'Each row is a supplier ledger; the balance is what is still to be paid.',
      'Tap one to see every purchase bill and payment behind that balance.',
      'Record a Payment to bring a balance down.',
    ],
  ),
  'contra': ModuleInfo(
    'Contra',
    'Money moving between your OWN accounts — cash to bank, bank to cash, or one bank to another. Nothing is earned or spent.',
    [
      'Pick the account money goes TO (Dr) and the one it comes FROM (Cr), then the amount.',
      'A cash deposit into the bank and an ATM withdrawal are both contra entries.',
      'It never touches a customer or supplier balance — only your own accounts.',
      'Syncs to Tally as a Contra voucher.',
    ],
  ),
  'stock-journal': ModuleInfo(
    'Stock Journals',
    'Moves stock WITHOUT a sale or purchase — godown-to-godown transfers, and manufacturing that consumes items to produce another.',
    [
      'Source lines take quantity OUT; destination lines put quantity IN.',
      'No party, no ledger, no GST — this voucher is quantities only.',
      'Use it to shift stock between godowns or to record production.',
      'Syncs to Tally as a Stock Journal voucher.',
    ],
  ),
  'physical-stock': ModuleInfo(
    'Physical Stock',
    'Your counted stock — what is ACTUALLY on the shelf, recorded as a sheet so the books can be corrected to reality.',
    [
      'Add each item with the quantity you counted; a count of 0 is valid and meaningful.',
      'One sheet is one count; the lines are grouped under its voucher number.',
      'Sheets are never edited — if a count was wrong, record a new sheet.',
      'Syncs to Tally as a Physical Stock voucher.',
    ],
  ),
  'inventory': ModuleInfo(
    'Inventory',
    'Your live stock position per product: opening + purchased − sold = current stock, with its value.',
    [
      'See current stock, stock value, and low-stock / out-of-stock counts at a glance.',
      'Filter by category, location, stock status or unit.',
      '"Stock Adjustment" manually corrects a product\'s quantity (needs edit rights).',
      'Numbers are derived from your invoices + opening stock.',
    ],
  ),

  // ── Reports / others ─────────────────────────────────────────────────────
  'reports': ModuleInfo(
    'Reports & Analytics',
    'Read-only business insights pulled to match Tally exactly — no editing, just answers.',
    [
      'Sales trend, cash flow, receivables aging, top customers/products, and headline KPIs.',
      'Figures come from your synced vouchers, so they tie to Tally to the paisa.',
      'Use them to spot overdue money, best sellers and slow months.',
    ],
  ),
  'expenses': ModuleInfo(
    'Expenses',
    'Record day-to-day business expenses (rent, salaries, utilities…) by category.',
    [
      'Log the amount, category, date and a note.',
      'Group by category to see where money goes.',
      'Feeds the cash-flow view in Analytics.',
    ],
  ),
  'users': ModuleInfo(
    'Users & Roles',
    'Your company logins and what each one is allowed to do (role-based permissions).',
    [
      'Create a role, tick which modules it can view / add / edit / delete, then assign it to users.',
      'A user only sees the menus + buttons their role grants — enforced on the server too.',
      'The super-admin decides which MODULES your licence has; you build roles from those.',
    ],
  ),
  'accountant-access': ModuleInfo(
    'Accountant Access',
    'Invite your CA / accountant to view your books online — no need to email files or share your Tally.',
    [
      'Send an invite with a role that decides what they can see (usually read-only reports & vouchers).',
      'They log in with their own credentials — you can show / reset their password anytime.',
      'Revoke access in one tap; they drop off the list immediately.',
    ],
  ),
  'settings': ModuleInfo(
    'Settings',
    'Company-wide preferences: invoice numbering, tax defaults, print/branding, and which modules push to Tally.',
    [
      'Set your default GST behaviour, invoice prefixes and print header/logo.',
      'Choose which modules auto-sync with the Tally desktop Agent.',
      'Changes apply to the whole company, so only admins can edit them.',
    ],
  ),
};

/// An AppBar ⓘ button that opens a "how this module works" dialog. Renders
/// nothing if the key is unknown.
class ModuleInfoButton extends StatelessWidget {
  const ModuleInfoButton(this.infoKey, {super.key});
  final String infoKey;

  @override
  Widget build(BuildContext context) {
    final info = kModuleInfo[infoKey];
    if (info == null) return const SizedBox.shrink();
    return IconButton(
      icon: const Icon(Icons.info_outline),
      tooltip: 'How this works',
      onPressed: () => showModuleInfo(context, infoKey),
    );
  }
}

/// Show the "how this module works" dialog for [infoKey].
Future<void> showModuleInfo(BuildContext context, String infoKey) {
  final info = kModuleInfo[infoKey];
  if (info == null) return Future.value();
  final theme = Theme.of(context);
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Row(children: [
        const Icon(Icons.info_outline, color: AppColors.primary, size: 22),
        const SizedBox(width: 8),
        Expanded(child: Text(info.title, style: theme.textTheme.titleMedium)),
      ]),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(info.intro, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 14),
              for (final p in info.points)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsets.only(top: 3, right: 8),
                        child: Icon(Icons.check, size: 15, color: AppColors.success),
                      ),
                      Expanded(child: Text(p, style: theme.textTheme.bodySmall)),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Got it')),
      ],
    ),
  );
}
