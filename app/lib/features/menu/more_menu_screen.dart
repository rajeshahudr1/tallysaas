import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_menu.dart';
import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../shared/widgets/app_card.dart';

/// Which of the web's three sidebar sections each menu group belongs to. The
/// web shows MAIN / MANAGE / SETTINGS as uppercase grey labels; the More screen
/// uses the same three so the products read alike. Unlisted groups fall to
/// MANAGE.
const Map<String, String> _kSection = {
  'Sales': 'MAIN',
  'Purchase': 'MAIN',
  'Cash & Bank': 'MAIN',
  'Customers': 'MANAGE',
  'Items': 'MANAGE',
  'Reports': 'MANAGE',
  'My Entries': 'MANAGE',
  'Field Sales': 'MANAGE',
  'Portals': 'MANAGE',
  'Tally Sync': 'MANAGE',
  'Configurations': 'SETTINGS',
  'General': 'SETTINGS',
};

const List<String> _kSectionOrder = ['MAIN', 'MANAGE', 'SETTINGS'];

String _sectionOf(MenuGroup g) => _kSection[g.label] ?? 'MANAGE';

/// "More" tab — every menu group the signed-in role may see, in the same order
/// and grouping as the web sidebar, under the web's MAIN / MANAGE / SETTINGS
/// section labels. Built modules push their route; the rest show a "Soon" tag
/// so the roadmap is visible instead of missing.
class MoreMenuScreen extends ConsumerWidget {
  const MoreMenuScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final groups = visibleMenu(user);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('More'),
        actions: [
          IconButton(
            icon: const Icon(Icons.person_outline),
            tooltip: 'Profile',
            onPressed: () => context.push('/profile'),
          ),
        ],
      ),
      body: groups.isEmpty
          ? const Center(child: Text('No modules available for your role.'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
              ),
              children: [
                for (final section in _kSectionOrder) ...[
                  if (groups.any((g) => _sectionOf(g) == section))
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, AppSpacing.lg16, 4, 0),
                      child: Text(
                        section,
                        style: theme.textTheme.titleSmall
                            ?.copyWith(letterSpacing: 1.1, color: AppColors.text3),
                      ),
                    ),
                  for (final g in groups.where((g) => _sectionOf(g) == section)) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        4, AppSpacing.md12, 4, AppSpacing.sm8,
                      ),
                      child: Row(
                        children: [
                          Icon(g.icon, size: 16, color: AppColors.text2),
                          const SizedBox(width: 8),
                          Text(g.label, style: theme.textTheme.titleMedium),
                        ],
                      ),
                    ),
                    for (final e in g.items) ...[
                      MenuEntryTile(e),
                      const SizedBox(height: AppSpacing.sm8),
                    ],
                  ],
                ],
              ],
            ),
    );
  }
}

/// One menu row: icon chip, label, chevron — or a "Soon" tag when the module's
/// screen is not built yet. Shared with the Sales / Purchase tab hubs so a
/// module looks identical wherever it is reached from.
class MenuEntryTile extends StatelessWidget {
  const MenuEntryTile(this.entry, {super.key});
  final MenuEntry entry;

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
            ..showSnackBar(SnackBar(content: Text('${entry.label} — coming soon.')));
        }
      },
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: enabled ? AppColors.primaryTint : AppColors.primary.withOpacity(0.06),
              borderRadius: BorderRadius.circular(AppRadius.md12),
            ),
            child: Icon(
              entry.icon,
              size: 20,
              color: enabled ? AppColors.primary : theme.disabledColor,
            ),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: Text(entry.label, style: theme.textTheme.titleMedium)),
          if (enabled)
            const Icon(Icons.chevron_right, color: AppColors.text3)
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: AppColors.border,
                borderRadius: BorderRadius.circular(AppRadius.pill999),
              ),
              child: Text(
                'Soon',
                style: theme.textTheme.labelSmall?.copyWith(color: AppColors.text3),
              ),
            ),
        ],
      ),
    );
  }
}
