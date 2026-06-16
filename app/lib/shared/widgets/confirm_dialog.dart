import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// A small reusable yes/no confirmation dialog. Returns `true` only when the
/// user taps the confirm action. Used for destructive / irreversible taps
/// (sign out, delete) so a stray tap doesn't act immediately.
///
/// Usage:
///   final ok = await ConfirmDialog.show(context,
///       title: 'Sign out?', message: '…', confirmLabel: 'Sign out',
///       danger: true);
///   if (ok) { … }
class ConfirmDialog {
  ConfirmDialog._();

  static Future<bool> show(
    BuildContext context, {
    required String title,
    required String message,
    String confirmLabel = 'Confirm',
    String cancelLabel = 'Cancel',
    bool danger = false,
  }) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actionsPadding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.sm8,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(cancelLabel),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: danger ? AppColors.danger : AppColors.primary,
            ),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return result ?? false;
  }
}
