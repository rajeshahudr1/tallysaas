import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../shared/widgets/app_card.dart';

/// Transactions hub — the Transactions bottom-nav tab. The web shows these in
/// the sidebar's "Transactions" group; on mobile that group becomes this hub of
/// cards. Tapping a built voucher type pushes its list screen; not-yet-built
/// ones show a "coming soon" note (wired in as each vertical lands).
class TransactionsHubScreen extends StatelessWidget {
  const TransactionsHubScreen({super.key});

  static const _items = <_TxnEntry>[
    _TxnEntry(
      title: 'Sales Invoices',
      subtitle: 'Outward — bills to customers',
      icon: Icons.receipt_long_outlined,
      route: '/sales-invoices',
    ),
    _TxnEntry(
      title: 'Purchase Invoices',
      subtitle: 'Inward — bills from suppliers',
      icon: Icons.shopping_bag_outlined,
      route: '/purchase-invoices',
    ),
    _TxnEntry(
      title: 'Payments',
      subtitle: 'Money paid out',
      icon: Icons.south_west,
      route: '/payments',
    ),
    _TxnEntry(
      title: 'Receipts',
      subtitle: 'Money received',
      icon: Icons.north_east,
      route: '/receipts',
    ),
    _TxnEntry(
      title: 'Journals',
      subtitle: 'Adjustment entries',
      icon: Icons.swap_horiz,
      route: '/journals',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Transactions')),
      body: ListView.separated(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        itemCount: _items.length,
        separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
        itemBuilder: (context, i) => _TxnTile(_items[i]),
      ),
    );
  }
}

class _TxnEntry {
  const _TxnEntry({
    required this.title,
    required this.subtitle,
    required this.icon,
    this.route,
  });
  final String title;
  final String subtitle;
  final IconData icon;
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
