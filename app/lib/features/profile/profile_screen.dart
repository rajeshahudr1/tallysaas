import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
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

          // ─── Account / admin shortcuts — ROLE-GATED (mirrors the web sidebar).
          //     Sync / Change History / Roles are admin-only; Settings / Users /
          //     Accountant follow the role's module permissions. A salesman sees
          //     only what their role grants — never Sync, Settings, Users, etc.
          ..._buildMenu(context, user),

          // Change Password — available to EVERY role.
          const SizedBox(height: AppSpacing.sm8),
          _MenuTile(
            icon: Icons.lock_outline,
            label: 'Change Password',
            onTap: () => _showChangePassword(context, ref),
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

/// Change-password dialog — every role. Verifies the current password server-
/// side (POST /account/change-password) then sets the new one.
Future<void> _showChangePassword(BuildContext context, WidgetRef ref) async {
  final current = TextEditingController();
  final next = TextEditingController();
  final confirm = TextEditingController();
  void snack(BuildContext c, String m) => ScaffoldMessenger.of(c)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(m)));

  await showDialog<void>(
    context: context,
    builder: (dctx) {
      bool busy = false;
      return StatefulBuilder(
        builder: (dctx, setLocal) => AlertDialog(
          title: const Text('Change Password'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: current, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
              const SizedBox(height: 10),
              TextField(controller: next, obscureText: true, decoration: const InputDecoration(labelText: 'New password (min 6)')),
              const SizedBox(height: 10),
              TextField(controller: confirm, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm new password')),
            ]),
          ),
          actions: [
            TextButton(onPressed: busy ? null : () => Navigator.pop(dctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      if (next.text.length < 6) { snack(dctx, 'New password must be at least 6 characters.'); return; }
                      if (next.text != confirm.text) { snack(dctx, 'New password and confirmation do not match.'); return; }
                      setLocal(() => busy = true);
                      try {
                        await ref.read(apiClientProvider).post('/account/change-password',
                            body: {'current_password': current.text, 'new_password': next.text});
                        if (dctx.mounted) Navigator.pop(dctx);
                        if (context.mounted) snack(context, 'Your password has been changed.');
                      } catch (e) {
                        setLocal(() => busy = false);
                        snack(dctx, e is ApiException ? e.message : 'Could not change your password.');
                      }
                    },
              child: busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Update'),
            ),
          ],
        ),
      );
    },
  );
  current.dispose();
  next.dispose();
  confirm.dispose();
}

/// Builds the role-gated shortcut list. Each entry appears ONLY when the user's
/// role allows it — admin-only items (Sync, Change History, Roles) need a
/// company/super admin; the rest follow the role's module permissions. Matches
/// the web sidebar RBAC exactly (no static menu items).
List<Widget> _buildMenu(BuildContext context, dynamic user) {
  final bool isAdmin = user.isSuperAdmin || user.roleSlug == 'company-admin';
  final entries = <_MenuEntry>[
    // Everyone may switch between the companies they can access.
    _MenuEntry(Icons.business_outlined, 'Switch Company', '/company-switcher', true),
    _MenuEntry(Icons.sync, 'Sync Dashboard', '/sync', isAdmin),
    _MenuEntry(Icons.list_alt_outlined, 'Sync Logs', '/sync-logs', isAdmin),
    _MenuEntry(Icons.history, 'Change History', '/change-history', isAdmin),
    _MenuEntry(Icons.settings_outlined, 'Settings', '/settings', user.canModule('settings') as bool),
    _MenuEntry(Icons.group_outlined, 'Users', '/users', user.canModule('users') as bool),
    _MenuEntry(Icons.shield_outlined, 'Roles & Permissions', '/roles', isAdmin),
    _MenuEntry(Icons.verified_user_outlined, 'Accountant Access', '/accountant-access', user.canModule('users') as bool),
  ];
  final visible = entries.where((e) => e.show).toList();
  final out = <Widget>[];
  for (var i = 0; i < visible.length; i++) {
    if (i > 0) out.add(const SizedBox(height: AppSpacing.sm8));
    final e = visible[i];
    out.add(_MenuTile(icon: e.icon, label: e.label, onTap: () => context.push(e.route)));
  }
  return out;
}

class _MenuEntry {
  const _MenuEntry(this.icon, this.label, this.route, this.show);
  final IconData icon;
  final String label;
  final String route;
  final bool show;
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
