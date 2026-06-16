import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Login / auth-page chrome. A full-bleed brand gradient (primary blue →
/// secondary violet, matching the web's `#2563EB`/`#6D28D9`) with a
/// centred white rounded card holding the form [child]. Keeps the auth
/// screens visually distinct from the in-app bottom-nav shell.
class AuthShell extends StatelessWidget {
  const AuthShell({super.key, required this.child});

  /// The form (or any content) rendered inside the centred white card.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [AppColors.primary, AppColors.secondary],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.xl24,
                vertical: AppSpacing.xl24,
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Container(
                  padding: const EdgeInsets.all(AppSpacing.xl24),
                  decoration: BoxDecoration(
                    color: AppColors.card,
                    borderRadius: BorderRadius.circular(AppRadius.lg16),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.18),
                        blurRadius: 28,
                        offset: const Offset(0, 12),
                      ),
                    ],
                  ),
                  child: child,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
