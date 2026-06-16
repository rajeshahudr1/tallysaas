import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'app_button.dart';

/// Full-pane error panel + optional retry. Shows the friendly message
/// from `ApiException.message`; callers pass [onRetry] to re-fire whatever
/// load they were doing.
class ErrorState extends StatelessWidget {
  const ErrorState(
    this.message, {
    super.key,
    this.onRetry,
    this.icon = Icons.error_outline,
  });

  final String message;
  final VoidCallback? onRetry;
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
            Icon(icon, size: 56, color: AppColors.danger),
            const SizedBox(height: AppSpacing.md12),
            Text(
              message,
              style: theme.textTheme.bodyLarge,
              textAlign: TextAlign.center,
            ),
            if (onRetry != null) ...[
              const SizedBox(height: AppSpacing.lg16),
              AppButton(
                label: 'Retry',
                icon: Icons.refresh,
                variant: AppButtonVariant.light,
                fullWidth: false,
                onPressed: onRetry,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
