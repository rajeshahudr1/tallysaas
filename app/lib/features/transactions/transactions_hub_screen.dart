import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../shared/widgets/app_card.dart';

/// Transactions hub — the Transactions bottom-nav tab. The web shows these in
/// the sidebar's "Transactions" group; on mobile that group becomes this hub of
/// cards. RBAC: each card is shown ONLY when the role grants its module's
/// permission (`canModule`), mirroring the web sidebar.
class TransactionsHubScreen extends ConsumerWidget {
  const TransactionsHubScreen({super.key});

  static const _items = <_TxnEntry>[
    _TxnEntry(
      title: 'Sales Invoices',
      subtitle: 'Outward — bills to customers',
      icon: Icons.receipt_long_outlined,
      route: '/sales-invoices',
      module: 'sales-invoices',
    ),
    _TxnEntry(
      title: 'Recurring Invoices',
      subtitle: 'Auto-generate on a schedule',
      icon: Icons.repeat,
      route: '/recurring-invoices',
      module: 'recurring-invoices',
    ),
    _TxnEntry(
      title: 'e-Invoice & e-Way',
      subtitle: 'GST IRN + e-Way Bill',
      icon: Icons.verified_outlined,
      route: '/einvoices',
      module: 'einvoice',
    ),
    _TxnEntry(
      title: 'Purchase Invoices',
      subtitle: 'Inward — bills from suppliers',
      icon: Icons.shopping_bag_outlined,
      route: '/purchase-invoices',
      module: 'purchase-invoices',
    ),
    _TxnEntry(
      title: 'Payments',
      subtitle: 'Money paid out',
      icon: Icons.south_west,
      route: '/payments',
      module: 'payments',
    ),
    _TxnEntry(
      title: 'Receipts',
      subtitle: 'Money received',
      icon: Icons.north_east,
      route: '/receipts',
      module: 'receipts',
    ),
    _TxnEntry(
      title: 'Payment Reminders',
      subtitle: 'Nudge overdue customers',
      icon: Icons.notifications_active_outlined,
      route: '/reminders',
      module: 'customers',
    ),
    _TxnEntry(
      title: 'Journals',
      subtitle: 'Adjustment entries',
      icon: Icons.swap_horiz,
      route: '/journals',
      module: 'journals',
    ),
    _TxnEntry(
      title: 'Expenses',
      subtitle: 'Business expense book',
      icon: Icons.account_balance_wallet_outlined,
      route: '/expenses',
      module: 'expenses',
    ),
    _TxnEntry(
      title: 'Bank Reconciliation',
      subtitle: 'Match statement to vouchers',
      icon: Icons.account_balance_outlined,
      route: '/bank-reconciliation',
      module: 'bank-reconciliation',
    ),
    _TxnEntry(
      title: 'Inventory / Stock',
      subtitle: 'Stock position per product',
      icon: Icons.warehouse_outlined,
      route: '/inventory',
      module: 'inventory',
    ),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final items = <_TxnEntry>[
      // SFA — a linked salesman's field home (My Field) is pinned first.
      if (user != null && user.isSalesman)
        const _TxnEntry(
          title: 'My Field',
          subtitle: 'My locations, customers & invoices',
          icon: Icons.location_on,
          module: 'sales-invoices',
          route: '/my-field',
        ),
      // SFA — Invoice Approvals for approvers (edit perm, not a field salesman).
      if (user != null && user.can('sales-invoices', 'edit') && !user.isSalesman)
        const _TxnEntry(
          title: 'Invoice Approvals',
          subtitle: 'Approve or reject salesman invoices',
          icon: Icons.fact_check,
          module: 'sales-invoices',
          route: '/sales-invoices/approvals',
        ),
      for (final e in _items)
        if (user == null || user.canModule(e.module)) e,
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Transactions')),
      body: items.isEmpty
          ? const Center(child: Text('No transactions available for your role.'))
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
              ),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (context, i) => _TxnTile(items[i]),
            ),
    );
  }
}

class _TxnEntry {
  const _TxnEntry({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.module,
    this.route,
  });
  final String title;
  final String subtitle;
  final IconData icon;
  final String module; // permission slug, e.g. 'sales-invoices' (matches the web)
  final String? route; // null → not built yet
}

class _TxnTile extends StatelessWidget {
  const _TxnTile(this.entry);
  final _TxnEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final enabled = entry.route != null;
    return AppCard(
      onTap: () {
        if (enabled) {
          context.push(entry.route!);
        } else {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text('${entry.title} — coming soon.')));
        }
      },
      child: Row(
        children: [
          Container(
            width: 44, height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(enabled ? 0.12 : 0.06),
              borderRadius: BorderRadius.circular(AppRadius.md12),
            ),
            child: Icon(entry.icon,
                color: enabled ? AppColors.primary : theme.disabledColor),
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
          if (enabled)
            const Icon(Icons.chevron_right, color: AppColors.text3)
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: AppColors.border,
                borderRadius: BorderRadius.circular(AppRadius.pill999),
              ),
              child: Text('Soon',
                  style: theme.textTheme.labelSmall?.copyWith(color: AppColors.text3)),
            ),
        ],
      ),
    );
  }
}
