import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Themed text field with a label above + optional validator hook. Wraps
/// `TextFormField` so every form gets the same input shape (label, padding,
/// error styling) inherited from `AppTheme`'s `inputDecorationTheme`.
class AppTextField extends StatelessWidget {
  const AppTextField({
    super.key,
    required this.controller,
    this.label,
    this.hint,
    this.obscure = false,
    this.keyboardType,
    this.validator,
    this.prefixIcon,
    this.textInputAction,
    this.onSubmitted,
    this.onChanged,
    this.enabled = true,
    this.maxLines = 1,
  });

  final TextEditingController controller;
  /// Optional label rendered above the field. Omit it for a bare box (e.g. a
  /// search field) where a hint is enough.
  final String? label;
  final String? hint;

  /// Masks input (passwords). Forces `maxLines` to 1.
  final bool obscure;
  final TextInputType? keyboardType;
  final FormFieldValidator<String>? validator;
  final IconData? prefixIcon;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onSubmitted;
  final ValueChanged<String>? onChanged;
  final bool enabled;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
            child: Text(label!, style: theme.textTheme.titleSmall),
          ),
        TextFormField(
          controller: controller,
          decoration: InputDecoration(
            hintText: hint,
            prefixIcon:
                prefixIcon == null ? null : Icon(prefixIcon, size: 18),
          ),
          validator: validator,
          keyboardType: keyboardType,
          obscureText: obscure,
          textInputAction: textInputAction,
          onFieldSubmitted: onSubmitted,
          onChanged: onChanged,
          enabled: enabled,
          maxLines: obscure ? 1 : maxLines,
        ),
      ],
    );
  }
}
