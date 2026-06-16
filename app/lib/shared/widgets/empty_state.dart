import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Reusable empty state — shown by list screens when the API returned
/// zero rows. Avoids the "blank list" anti-pattern by saying *why* the
/// list is empty, with a folder/inbox icon for visual weight.
class EmptyState extends StatelessWidget {
  const EmptyState(
    this.message, {
    super.key,
    this.icon = Icons.folder_open_outlined,
  });

  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: AppColors.text3),
            const SizedBox(height: AppSpacing.md12),
            Text(
              message,
              style: theme.textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
