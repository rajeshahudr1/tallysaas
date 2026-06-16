import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Centred spinner with an optional message. Used by list/detail screens
/// before the first fetch lands, and anywhere a full-pane "loading…" is
/// the right placeholder.
class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation<Color>(AppColors.primary),
          ),
          if (message != null) ...[
            const SizedBox(height: AppSpacing.md12),
            Text(message!, style: theme.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}
