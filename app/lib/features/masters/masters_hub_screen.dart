import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../shared/widgets/app_card.dart';

/// Masters hub — the second bottom-nav tab. The web shows every master in the
/// sidebar's "Masters" group; on mobile that group becomes this hub of cards.
/// Tapping a built master pushes its list screen; not-yet-built ones show a
/// "coming soon" note (wired in as each vertical lands, one by one).
///
/// RBAC: each card carries the same permission `module` slug the web sidebar
/// uses (`customers`, `suppliers`, …). A card is shown ONLY when the signed-in
/// role grants access to that module (`user.canModule(slug)`) — Super/Company
/// admin (`*`) see all, a Sales/Accountant role sees only its granted masters.
class MastersHubScreen extends ConsumerWidget {
  const MastersHubScreen({super.key});

  static const _items = <_MasterEntry>[
    _MasterEntry(
      title: 'Companies',
      subtitle: 'Tally companies',
      icon: Icons.business_outlined,
      route: '/companies',
      module: 'companies',
    ),
    _MasterEntry(
      title: 'Customers',
      subtitle: 'Sundry debtors — buyers',
      icon: Icons.people_outline,
      route: '/customers',
      module: 'customers',
    ),
    _MasterEntry(
      title: 'Suppliers',
      subtitle: 'Sundry creditors — vendors',
      icon: Icons.local_shipping_outlined,
      route: '/suppliers',
      module: 'suppliers',
    ),
    _MasterEntry(
      title: 'Products',
      subtitle: 'Stock items & services',
      icon: Icons.inventory_2_outlined,
      route: '/products',
      module: 'products',
    ),
    _MasterEntry(
      title: 'Categories',
      subtitle: 'Product groups',
      icon: Icons.category_outlined,
      route: '/categories',
      module: 'categories',
    ),
    _MasterEntry(
      title: 'Locations',
      subtitle: 'Branches & warehouses',
      icon: Icons.place_outlined,
      route: '/locations',
      module: 'locations',
    ),
    _MasterEntry(
      title: 'Sales Persons',
      subtitle: 'Field & counter staff',
      icon: Icons.badge_outlined,
      route: '/sales-persons',
      module: 'sales-persons',
    ),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // RBAC: keep only the masters this role may see (admins see all).
    final items = [
      for (final e in _items)
        if (user == null || user.canModule(e.module)) e,
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Masters')),
      body: items.isEmpty
          ? const Center(child: Text('No masters available for your role.'))
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
              ),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (context, i) => _MasterTile(items[i]),
            ),
    );
  }
}

class _MasterEntry {
  const _MasterEntry({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.module,
    this.route,
  });
  final String title;
  final String subtitle;
  final IconData icon;
  final String module; // permission slug, e.g. 'customers' (matches the web)
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
