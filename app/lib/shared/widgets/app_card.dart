import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Consistent card surface — bordered, rounded, themed. Wraps `Card` so
/// every list / detail / settings panel shares the same shape without
/// reinventing the padding + radius at each callsite. An optional [onTap]
/// turns it into a ripple-able row.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.lg16),
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final content = Padding(padding: padding, child: child);
    final shape = RoundedRectangleBorder(
      side: const BorderSide(color: AppColors.border, width: 1),
      borderRadius: BorderRadius.circular(AppRadius.md12),
    );

    return Material(
      color: theme.cardColor,
      shape: shape,
      clipBehavior: Clip.antiAlias,
      child: onTap == null
          ? content
          : InkWell(onTap: onTap, child: content),
    );
  }
}
