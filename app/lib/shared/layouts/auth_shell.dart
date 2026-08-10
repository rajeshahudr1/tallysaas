import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Login / auth-page chrome. Mirrors the web sign-in's mobile breakpoint: a
/// plain white page with the content centred in a single readable column —
/// no gradient wash, no floating card, no decorative artwork. The brand
/// colour shows up only where it acts (the gradient CTA inside [child]).
class AuthShell extends StatelessWidget {
  const AuthShell({super.key, required this.child});

  /// The form (or any content) rendered in the centred column.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.card,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.xl24,
              vertical: AppSpacing.xl24,
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}
