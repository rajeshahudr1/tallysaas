import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_menu.dart';
import '../../app/theme.dart';
import '../../core/auth/session.dart';
import 'more_menu_screen.dart' show MenuEntryTile;

/// A bottom-nav tab that renders ONE menu group (Sales, Purchase). Same rows as
/// the More screen, so a module looks identical wherever it is reached from.
class GroupHubScreen extends ConsumerWidget {
  const GroupHubScreen({super.key, required this.groupLabel});
  final String groupLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // visibleMenu applies the same RBAC rules the More screen uses.
    final matches = visibleMenu(user).where((g) => g.label == groupLabel).toList();
    final group = matches.isEmpty ? null : matches.first;

    return Scaffold(
      appBar: AppBar(title: Text(groupLabel)),
      body: group == null
          ? Center(child: Text('No $groupLabel modules for your role.'))
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
              ),
              itemCount: group.items.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => MenuEntryTile(group.items[i]),
            ),
    );
  }
}
