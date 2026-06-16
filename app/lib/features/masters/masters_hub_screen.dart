import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../shared/widgets/app_card.dart';

/// Masters hub — the second bottom-nav tab. The web shows every master in the
/// sidebar's "Masters" group; on mobile that group becomes this hub of cards.
/// Tapping a built master pushes its list screen; not-yet-built ones show a
/// "coming soon" note (wired in as each vertical lands, one by one).
class MastersHubScreen extends StatelessWidget {
  const MastersHubScreen({super.key});

  static const _items = <_MasterEntry>[
    _MasterEntry(
      title: 'Customers',
      subtitle: 'Sundry debtors — buyers',
      icon: Icons.people_outline,
      route: '/customers',
    ),
    _MasterEntry(
      title: 'Suppliers',
      subtitle: 'Sundry creditors — vendors',
      icon: Icons.local_shipping_outlined,
      route: '/suppliers',
    ),
    _MasterEntry(
      title: 'Products',
      subtitle: 'Stock items & services',
      icon: Icons.inventory_2_outlined,
      route: '/products',
    ),
    _MasterEntry(
      title: 'Categories',
      subtitle: 'Product groups',
      icon: Icons.category_outlined,
      route: '/categories',
    ),
    _MasterEntry(
      title: 'Locations',
      subtitle: 'Branches & warehouses',
      icon: Icons.place_outlined,
      route: '/locations',
    ),
    _MasterEntry(
      title: 'Sales Persons',
      subtitle: 'Field & counter staff',
      icon: Icons.badge_outlined,
      route: '/sales-persons',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Masters')),
      body: ListView.separated(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        itemCount: _items.length,
        separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
        itemBuilder: (context, i) => _MasterTile(_items[i]),
      ),
    );
  }
}

class _MasterEntry {
  const _MasterEntry({
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

class _MasterTile extends StatelessWidget {
  const _MasterTile(this.entry);
  final _MasterEntry entry;

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
