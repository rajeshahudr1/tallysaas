import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Visual intent for [AppButton]. `primary` is the solid brand-blue CTA
/// (white foreground, from the theme); `light` is a soft tinted button
/// used for secondary actions on a busy screen.
enum AppButtonVariant { primary, light }

/// Single button widget with a built-in loading state and optional
/// leading icon. Use this everywhere instead of constructing
/// `ElevatedButton` directly so the brand styling lives in one place.
class AppButton extends StatelessWidget {
  const AppButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.loading = false,
    this.icon,
    this.variant = AppButtonVariant.primary,
    this.fullWidth = true,
  });

  final String label;
  final VoidCallback? onPressed;

  /// When true the label/icon are swapped for a spinner and taps are
  /// ignored — used while the bound request is in flight.
  final bool loading;
  final IconData? icon;
  final AppButtonVariant variant;

  /// Buttons stretch to the available width by default (forms, dialogs);
  /// set false for an inline / hug-content button.
  final bool fullWidth;

  @override
  Widget build(BuildContext context) {
    final disabled = loading || onPressed == null;
    final isLight = variant == AppButtonVariant.light;

    // Spinner colour tracks the foreground so it reads on either variant.
    final spinnerColor = isLight ? AppColors.primary : Colors.white;

    final child = loading
        ? SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(spinnerColor),
            ),
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18),
                const SizedBox(width: AppSpacing.sm8),
              ],
              Text(label),
            ],
          );

    final style = isLight
        ? ElevatedButton.styleFrom(
            backgroundColor: AppColors.primary.withOpacity(0.10),
            foregroundColor: AppColors.primary,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm8),
            ),
          )
        : null; // primary falls back to the themed ElevatedButton style.

    final btn = ElevatedButton(
      style: style,
      onPressed: disabled ? null : onPressed,
      child: child,
    );

    return fullWidth ? SizedBox(width: double.infinity, child: btn) : btn;
  }
}
