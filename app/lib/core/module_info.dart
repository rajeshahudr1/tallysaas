import 'package:flutter/material.dart';

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
        const Icon(Icons.info_outline, color: Color(0xFF2563EB), size: 22),
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
                        child: Icon(Icons.check, size: 15, color: Color(0xFF16A34A)),
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
