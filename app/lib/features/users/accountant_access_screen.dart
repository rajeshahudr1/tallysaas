import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Accountant Access — "share your books with your CA". One tap invites an
/// accountant who gets a SAFE, read-only login (a curated Accountant role,
/// view + export only — never create/edit/delete). Mirrors LiveKeeping's CA
/// sharing but goes further: the role is auto-built + scoped to the licence.
final _accountantsProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/account/accountants');
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

/// Roles the company can assign to an accountant (their own custom roles). Blank
/// pick → the API falls back to the safe auto "Accountant" read-only role.
final _assignableRolesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/roles', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

class AccountantAccessScreen extends ConsumerWidget {
  const AccountantAccessScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_accountantsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Accountant Access'), actions: const [ModuleInfoButton('accountant-access')]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _invite(context, ref),
        icon: const Icon(Icons.person_add_alt),
        label: const Text('Invite CA'),
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load accountants.',
          onRetry: () => ref.invalidate(_accountantsProvider),
        ),
        data: (list) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(_accountantsProvider),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
            children: [
              const _IntroCard(),
              const SizedBox(height: AppSpacing.md12),
              if (list.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: AppSpacing.xxl32),
                  child: Center(
                    child: Text('No accountant added yet.\nTap "Invite CA" to share your books.',
                        textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)),
                  ),
                )
              else
                ...list.map((a) => Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                      child: _AccountantCard(a, onRevoke: () => _revoke(context, ref, a)),
                    )),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _invite(BuildContext context, WidgetRef ref) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => const _InviteSheet(),
    );
    if (ok == true) ref.invalidate(_accountantsProvider);
  }

  Future<void> _revoke(BuildContext context, WidgetRef ref, Map<String, dynamic> a) async {
    final yes = await ConfirmDialog.show(
      context,
      title: 'Revoke access?',
      message: '${a['name'] ?? 'This accountant'} will no longer be able to sign in.',
      confirmLabel: 'Revoke',
      danger: true,
    );
    if (!yes) return;
    try {
      await ref.read(apiClientProvider).delete('/account/accountants/${a['id']}');
      ref.invalidate(_accountantsProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Access revoked.')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e is ApiException ? e.message : 'Could not revoke: $e')));
      }
    }
  }
}

class _IntroCard extends StatelessWidget {
  const _IntroCard();
  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40, height: 40,
            decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            alignment: Alignment.center,
            child: const Icon(Icons.verified_user_outlined, color: AppColors.primary),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Share your books with your CA', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 4),
                Text(
                  'They get a SAFE, read-only login — can view & export reports, ledgers, invoices and outstanding, but cannot change anything.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AccountantCard extends StatelessWidget {
  const _AccountantCard(this.a, {required this.onRevoke});
  final Map<String, dynamic> a;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = '${a['name'] ?? ''}';
    final email = '${a['email'] ?? ''}';
    final status = '${a['status'] ?? ''}';
    final role = '${a['role'] ?? ''}';
    final lastLogin = a['last_login_at'];
    return AppCard(
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: AppColors.primary,
            child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: theme.textTheme.titleMedium),
                if (email.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(email, style: theme.textTheme.bodySmall),
                ],
                if (role.isNotEmpty) ...[
                  const SizedBox(height: 5),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.10),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(role,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 11.5)),
                  ),
                ],
                const SizedBox(height: 3),
                Text(lastLogin == null ? 'Never signed in' : 'Last login recorded',
                    style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (status.isNotEmpty) StatusPill(status),
              const SizedBox(height: 6),
              TextButton(
                onPressed: onRevoke,
                style: TextButton.styleFrom(foregroundColor: AppColors.danger, padding: EdgeInsets.zero, minimumSize: const Size(0, 0)),
                child: const Text('Revoke'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Invite form: name + email + a password the CA will use to sign in.
class _InviteSheet extends ConsumerStatefulWidget {
  const _InviteSheet();
  @override
  ConsumerState<_InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends ConsumerState<_InviteSheet> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  int? _roleId; // null → the API assigns the safe auto "Accountant" read-only role

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/account/accountants', body: {
        'name': _name.text.trim(),
        'email': _email.text.trim(),
        'password': _password.text,
        if (_roleId != null) 'role_id': _roleId,
      });
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Accountant invited.')));
    } on ApiException catch (e) {
      _err(e.message);
    } catch (e) {
      _err('Could not invite: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _err(String m) {
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16,
        AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              const Text('Invite Accountant', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: AppSpacing.sm8),
            AppTextField(controller: _name, label: 'Accountant name *', prefixIcon: Icons.person_outline,
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Name is required' : null),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _email, label: 'Email *', keyboardType: TextInputType.emailAddress, prefixIcon: Icons.email_outlined,
                validator: (v) => (v == null || !v.contains('@')) ? 'Valid email required' : null),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _password, label: 'Set a password *', obscure: _obscure, prefixIcon: Icons.lock_outline,
                suffix: IconButton(
                  icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 18),
                  onPressed: () => setState(() => _obscure = !_obscure),
                  tooltip: _obscure ? 'Show password' : 'Hide password',
                ),
                validator: (v) => (v == null || v.length < 8) ? 'Min 8 characters' : null),
            const SizedBox(height: 6),
            Text('Share this password with your CA so they can sign in.',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.md12),
            // Role — leave default for the safe read-only Accountant role, or pick
            // one of the company's own roles.
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
              child: Text('Role', style: Theme.of(context).textTheme.titleSmall),
            ),
            ref.watch(_assignableRolesProvider).maybeWhen(
              data: (roles) => DropdownButtonFormField<int?>(
                value: _roleId,
                isExpanded: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.badge_outlined, size: 18)),
                items: [
                  const DropdownMenuItem<int?>(value: null, child: Text('Accountant (read-only) — default')),
                  ...roles.map((r) => DropdownMenuItem<int?>(
                        value: r['id'] as int?,
                        child: Text('${r['name'] ?? ''}', overflow: TextOverflow.ellipsis),
                      )),
                ],
                onChanged: (v) => setState(() => _roleId = v),
              ),
              orElse: () => DropdownButtonFormField<int?>(
                value: null,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.badge_outlined, size: 18)),
                items: const [DropdownMenuItem<int?>(value: null, child: Text('Accountant (read-only) — default'))],
                onChanged: null,
              ),
            ),
            const SizedBox(height: AppSpacing.lg16),
            FilledButton.icon(
              onPressed: _busy ? null : _save,
              icon: _busy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.check),
              label: const Text('Send Invite'),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ),
      ),
    );
  }
}
