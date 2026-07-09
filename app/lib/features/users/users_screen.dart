import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Users — the company's login accounts (GET /users): name, email, role, status.
/// Mirrors the web's Users page. A + opens an add form (name/email/role/password
/// → POST /users). Creating a login consumes a licence seat.
final _usersProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/users', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

final _rolesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/roles', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

class UsersScreen extends ConsumerWidget {
  const UsersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_usersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Users'), actions: const [ModuleInfoButton('users')]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openForm(context, ref),
        icon: const Icon(Icons.person_add_alt),
        label: const Text('Add User'),
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading users…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load users.',
          onRetry: () => ref.invalidate(_usersProvider),
        ),
        data: (users) {
          if (users.isEmpty) {
            return const EmptyState('No users yet. Add a login with the + button.', icon: Icons.group_outlined);
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_usersProvider),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: users.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _UserCard(users[i]),
            ),
          );
        },
      ),
    );
  }

  Future<void> _openForm(BuildContext context, WidgetRef ref) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => const _UserFormSheet(),
    );
    if (ok == true) ref.invalidate(_usersProvider);
  }
}

class _UserCard extends StatelessWidget {
  const _UserCard(this.u);
  final Map<String, dynamic> u;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = '${u['name'] ?? ''}';
    final email = '${u['email'] ?? ''}';
    final role = '${u['role'] ?? u['role_name'] ?? ''}';
    final status = '${u['status'] ?? ''}';
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
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
                    child: Text(role, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.primary)),
                  ),
                ],
              ],
            ),
          ),
          if (status.isNotEmpty) StatusPill(status),
        ],
      ),
    );
  }
}

/// Add-user bottom sheet: name, email, role (live from /roles), password, status
/// → POST /users. Returns true on success so the list refreshes.
class _UserFormSheet extends ConsumerStatefulWidget {
  const _UserFormSheet();
  @override
  ConsumerState<_UserFormSheet> createState() => _UserFormSheetState();
}

class _UserFormSheetState extends ConsumerState<_UserFormSheet> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  int? _roleId;
  String _status = 'Active';
  bool _busy = false;

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
    if (_roleId == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Pick a role.')));
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/users', body: {
        'name': _name.text.trim(),
        'email': _email.text.trim(),
        'role_id': _roleId,
        'password': _password.text,
        'status': _status,
      });
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      _err(e.message);
    } catch (e) {
      _err('Could not create user: $e');
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
    final rolesAsync = ref.watch(_rolesProvider);
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
              const Text('Add User', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: AppSpacing.sm8),
            AppTextField(controller: _name, label: 'Name *', prefixIcon: Icons.person_outline,
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Name is required' : null),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _email, label: 'Email *', keyboardType: TextInputType.emailAddress, prefixIcon: Icons.email_outlined,
                validator: (v) => (v == null || !v.contains('@')) ? 'Valid email required' : null),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _password, label: 'Password *', obscure: true, prefixIcon: Icons.lock_outline,
                validator: (v) => (v == null || v.length < 8) ? 'Min 8 characters' : null),
            const SizedBox(height: AppSpacing.md12),
            Text('Role *', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            rolesAsync.when(
              loading: () => const LinearProgressIndicator(),
              error: (_, __) => const Text('Could not load roles'),
              data: (roles) => DropdownButtonFormField<int>(
                value: _roleId,
                isExpanded: true,
                hint: const Text('Select role'),
                items: [for (final r in roles) DropdownMenuItem(value: (r['id'] as num).toInt(), child: Text('${r['name'] ?? ''}'))],
                onChanged: (v) => setState(() => _roleId = v),
              ),
            ),
            const SizedBox(height: AppSpacing.md12),
            Text('Status', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            DropdownButtonFormField<String>(
              value: _status,
              items: const ['Active', 'Inactive', 'Blocked'].map((s) => DropdownMenuItem(value: s, child: Text(s))).toList(),
              onChanged: (v) => setState(() => _status = v ?? 'Active'),
            ),
            const SizedBox(height: AppSpacing.lg16),
            FilledButton.icon(
              onPressed: _busy ? null : _save,
              icon: _busy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.check),
              label: const Text('Create User'),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ),
      ),
    );
  }
}
