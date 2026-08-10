import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../shared/widgets/app_card.dart';
import '../registers/grouped_register_screen.dart';
import '../registers/cost_centre_screen.dart';
import '../registers/stock_grouping_screen.dart';

/// Reports hub — the Reports bottom-nav tab. Mirrors the Masters hub: an
/// AppBar + a ListView of tiles grouped into sections (Registers, Statements,
/// Inventory, Outstanding). Each tile pushes its detail route, which renders
/// the matching Tally-style report viewer.
///
/// NOTE: the class name `ReportsScreen` is referenced by the router as the
/// Reports tab — do not rename it.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  // NOT const: the grouped-view tiles carry a builder, and a method call
  // cannot appear in a const expression.
  static final _groups = <_ReportGroup>[
    const _ReportGroup('Insights', [
      _ReportEntry(
        title: 'Business Analytics',
        subtitle: 'Sales trend, cash flow, aging, top customers & products',
        icon: Icons.insights_outlined,
        route: '/analytics',
      ),
    ]),
    const _ReportGroup('Registers', [
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
    const _ReportGroup('Outstanding', [
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
    const _ReportGroup('Statements', [
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
    // These open an existing screen on a particular VIEW rather than being
    // screens of their own — the same thing Tally's report menu does. A second
    // copy would only give one number two places to drift.
    _ReportGroup('Sales Overview', [
      _ReportEntry(
        title: 'By Ledger',
        subtitle: 'Sales grouped by party ledger',
        icon: Icons.contacts_outlined,
        builder: _grouped('/sales-invoices', 'Sales Register', 'ledger'),
      ),
      _ReportEntry(
        title: 'By Stock Item',
        subtitle: 'Sales grouped by item, with quantity',
        icon: Icons.inventory_2_outlined,
        builder: _grouped('/sales-invoices', 'Sales Register', 'stock_item'),
      ),
    ]),
    _ReportGroup('Purchase Overview', [
      _ReportEntry(
        title: 'Grouped Purchases',
        subtitle: 'By ledger, item, voucher type, group or category',
        icon: Icons.pivot_table_chart_outlined,
        builder: _grouped('/purchase-invoices', 'Purchase Register', 'ledger'),
      ),
    ]),
    const _ReportGroup('Stock Reports', [
      _ReportEntry(
        title: 'Stock Summary',
        subtitle: 'Closing stock by group, godown or category',
        icon: Icons.warehouse_outlined,
        builder: _stockGrouping,
      ),
    ]),
    const _ReportGroup('Cost Centre', [
      _ReportEntry(
        title: 'Cost Centres',
        subtitle: 'Summary, plus the same spend split by ledger or group',
        icon: Icons.account_tree_outlined,
        builder: _costCentres,
      ),
    ]),
  ];

  // Builders are statics so the tiles above can name them directly.
  static WidgetBuilder _grouped(String basePath, String title, String view) =>
      (_) => GroupedRegisterScreen(basePath: basePath, title: title, initialView: view);

  static Widget _stockGrouping(BuildContext _) => const StockGroupingScreen();

  static Widget _costCentres(BuildContext _) => const CostCentreScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // RBAC: Reports is a single 'reports' module (no per-report perms, like the
    // web). The bottom-nav already hides the tab without it; this guards a
    // direct deep-link too.
    if (user != null && !user.canModule('reports')) {
      return Scaffold(
        appBar: AppBar(title: const Text('Reports'), actions: const [ModuleInfoButton('reports')]),
        body: const Center(child: Text('Reports are not available for your role.')),
      );
    }

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
      appBar: AppBar(title: const Text('Reports'), actions: const [ModuleInfoButton('reports')]),
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
    this.route,
    this.builder,
  }) : assert(route != null || builder != null,
            'a report tile needs somewhere to go');

  final String title;
  final String subtitle;
  final IconData icon;

  /// A named app route. Used for reports that ARE a screen of their own.
  final String? route;

  /// Some reports are an existing screen opened on a particular view (the
  /// grouped registers, the stock roll-ups). Those take a builder rather than
  /// a route: the app's screens read their state from controllers, not from
  /// query strings, so a URL like `/products?stock=in` would navigate but
  /// silently apply no filter.
  final WidgetBuilder? builder;
}

class _ReportTile extends StatelessWidget {
  const _ReportTile(this.entry);
  final _ReportEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      onTap: () {
        final b = entry.builder;
        if (b != null) {
          Navigator.of(context).push(MaterialPageRoute(builder: b));
        } else {
          context.push(entry.route!);
        }
      },
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
