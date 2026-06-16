import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/session.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/empty_state.dart';

/// Profile tab — surfaces the signed-in user (name, email, role) and a
/// Sign-out action. The user comes straight off `sessionProvider`; logging
/// out flips the session to anonymous, which the router observes and bounces
/// the user back to /login. Richer edit-profile flows arrive in a later phase.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;

    if (user == null) {
      // Defensive: the router keeps anonymous users off this tab, but if the
      // session is mid-transition we show a friendly empty state rather than
      // crashing on a null user.
      return Scaffold(
        appBar: AppBar(title: const Text('Profile')),
        body: const EmptyState(
          'Sign in to view your profile.',
          icon: Icons.person_off_outlined,
        ),
      );
    }

    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          // ─── Identity card ──────────────────────────────────
          AppCard(
            child: Row(
              children: [
                _Avatar(initials: user.initials),
                const SizedBox(width: AppSpacing.md12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(user.name, style: theme.textTheme.titleMedium),
                      const SizedBox(height: 2),
                      Text(user.email, style: theme.textTheme.bodySmall),
                      if (user.role.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        _RoleChip(role: user.role),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: AppSpacing.xl24),

          // ─── Account / admin shortcuts ──────────────────────
          _MenuTile(
            icon: Icons.business_outlined,
            label: 'Switch Company',
            onTap: () => context.push('/company-switcher'),
          ),
          const SizedBox(height: AppSpacing.sm8),
          _MenuTile(
            icon: Icons.sync,
            label: 'Tally Sync',
            onTap: () => context.push('/sync'),
          ),
          const SizedBox(height: AppSpacing.sm8),
          _MenuTile(
            icon: Icons.settings_outlined,
            label: 'Settings',
            onTap: () => context.push('/settings'),
          ),

          const SizedBox(height: AppSpacing.xl24),

          // ─── Sign out ───────────────────────────────────────
          AppButton(
            label: 'Sign out',
            icon: Icons.logout,
            variant: AppButtonVariant.light,
            onPressed: () async {
              final ok = await ConfirmDialog.show(
                context,
                title: 'Sign out?',
                message: 'You will need to sign in again to access your account.',
                confirmLabel: 'Sign out',
                danger: true,
              );
              if (ok) ref.read(authServiceProvider).logout();
            },
          ),
        ],
      ),
    );
  }
}

/// A tappable account/admin shortcut row (Switch Company, Tally Sync, Settings).
class _MenuTile extends StatelessWidget {
  const _MenuTile({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, color: AppColors.primary, size: 22),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: Text(label, style: theme.textTheme.titleSmall)),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}

/// Circular brand-tinted initials block — a lightweight stand-in for a
/// profile photo (none in the Phase 1 user shape).
class _Avatar extends StatelessWidget {
  const _Avatar({required this.initials});
  final String initials;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56,
      height: 56,
      decoration: const BoxDecoration(
        color: AppColors.primary,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initials,
        style: const TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w800,
          fontSize: 20,
        ),
      ),
    );
  }
}

/// Soft pill showing the user's human-readable role name.
class _RoleChip extends StatelessWidget {
  const _RoleChip({required this.role});
  final String role;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: AppColors.primary.withOpacity(0.12),
        borderRadius: BorderRadius.circular(AppRadius.pill999),
      ),
      child: Text(
        role,
        style: const TextStyle(
          color: AppColors.primary,
          fontWeight: FontWeight.w700,
          fontSize: 11,
        ),
      ),
    );
  }
}
