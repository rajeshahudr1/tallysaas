import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../shared/widgets/app_card.dart';

/// Reports hub — the Reports bottom-nav tab. Mirrors the Masters hub: an
/// AppBar + a ListView of tiles grouped into sections (Registers, Statements,
/// Inventory, Outstanding). Each tile pushes its detail route, which renders
/// the matching Tally-style report viewer.
///
/// NOTE: the class name `ReportsScreen` is referenced by the router as the
/// Reports tab — do not rename it.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  static const _groups = <_ReportGroup>[
    _ReportGroup('Registers', [
      _ReportEntry(
        title: 'Sales Register',
        subtitle: 'Tax invoices with taxable, GST & totals',
        icon: Icons.receipt_long_outlined,
        route: '/reports/sales-register',
      ),
      _ReportEntry(
        title: 'Day Book',
        subtitle: 'All vouchers — sales, purchase, receipts, payments',
        icon: Icons.menu_book_outlined,
        route: '/reports/day-book',
      ),
    ]),
    _ReportGroup('Outstanding', [
      _ReportEntry(
        title: 'Receivables',
        subtitle: 'Sundry debtors — what customers owe you',
        icon: Icons.call_received_outlined,
        route: '/reports/receivables',
      ),
      _ReportEntry(
        title: 'Payables',
        subtitle: 'Sundry creditors — what you owe suppliers',
        icon: Icons.call_made_outlined,
        route: '/reports/payables',
      ),
      _ReportEntry(
        title: 'Party Ledger',
        subtitle: 'A party account statement with running balance',
        icon: Icons.account_balance_wallet_outlined,
        route: '/reports/ledger',
      ),
    ]),
    _ReportGroup('Statements', [
      _ReportEntry(
        title: 'GST Summary',
        subtitle: 'Output vs input GST and net payable',
        icon: Icons.percent_outlined,
        route: '/reports/gst-summary',
      ),
      _ReportEntry(
        title: 'Trial Balance',
        subtitle: 'Ledger debit / credit balances',
        icon: Icons.balance_outlined,
        route: '/reports/trial-balance',
      ),
      _ReportEntry(
        title: 'Profit & Loss',
        subtitle: 'Trading account — income vs expenses',
        icon: Icons.trending_up_outlined,
        route: '/reports/profit-loss',
      ),
      _ReportEntry(
        title: 'Balance Sheet',
        subtitle: 'Assets vs liabilities',
        icon: Icons.account_tree_outlined,
        route: '/reports/balance-sheet',
      ),
    ]),
    _ReportGroup('Inventory', [
      _ReportEntry(
        title: 'Stock Summary',
        subtitle: 'Items with quantity, rate & value',
        icon: Icons.inventory_2_outlined,
        route: '/reports/stock-summary',
      ),
    ]),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final children = <Widget>[];
    for (final group in _groups) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.xs4, AppSpacing.lg16, AppSpacing.xs4, AppSpacing.sm8,
        ),
        child: Text(group.title, style: theme.textTheme.titleSmall),
      ));
      for (final entry in group.entries) {
        children.add(Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: _ReportTile(entry),
        ));
      }
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Reports')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.xs4, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: children,
      ),
    );
  }
}

class _ReportGroup {
  const _ReportGroup(this.title, this.entries);
  final String title;
  final List<_ReportEntry> entries;
}

class _ReportEntry {
  const _ReportEntry({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.route,
  });
  final String title;
  final String subtitle;
  final IconData icon;
  final String route;
}

class _ReportTile extends StatelessWidget {
  const _ReportTile(this.entry);
  final _ReportEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      onTap: () => context.push(entry.route),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.12),
              borderRadius: BorderRadius.circular(AppRadius.md12),
            ),
            child: Icon(entry.icon, color: AppColors.primary),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.title, style: theme.textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(entry.subtitle, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}
