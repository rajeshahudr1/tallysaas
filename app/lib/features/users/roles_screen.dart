import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Roles & Permissions — lists the company's roles (GET /roles); tapping one
/// opens a module × action permission matrix (GET /account/roles/:id for the
/// role's current slugs + /account/roles/available-permissions for the grid)
/// and saves via PUT /account/roles/:id/permissions { slugs }. Mirrors the web.
final _rolesListProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/roles', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

class RolesScreen extends ConsumerWidget {
  const RolesScreen({super.key});

  /// Create a brand-new custom role for this company (POST /account/roles) and
  /// jump straight into its permission matrix.
  Future<void> _addRole(BuildContext context, WidgetRef ref) async {
    final ctl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Add Role'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Role name', hintText: 'e.g. Sales Person'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, ctl.text.trim()), child: const Text('Create')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    try {
      final created = await ref.read(apiClientProvider).post('/account/roles', body: {'name': name});
      ref.invalidate(_rolesListProvider);
      final id = (created is Map && created['id'] != null) ? (created['id'] as num).toInt() : null;
      if (id != null && context.mounted) {
        Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => RolePermissionsScreen(roleId: id, roleName: name)));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e is ApiException ? e.message : 'Could not create role: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_rolesListProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Roles & Permissions')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _addRole(context, ref),
        icon: const Icon(Icons.add),
        label: const Text('Add Role'),
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading roles…'),
        error: (e, _) => ErrorState(e is ApiException ? e.message : 'Could not load roles.', onRetry: () => ref.invalidate(_rolesListProvider)),
        data: (roles) {
          if (roles.isEmpty) return const EmptyState('No roles found.', icon: Icons.shield_outlined);
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_rolesListProvider),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: roles.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) {
                final r = roles[i];
                final id = (r['id'] as num).toInt();
                final name = '${r['name'] ?? ''}';
                final isSystem = r['is_system'] == true;
                return AppCard(
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => RolePermissionsScreen(roleId: id, roleName: name, isSystem: isSystem))),
                  child: Row(
                    children: [
                      const Icon(Icons.shield_outlined, color: AppColors.primary),
                      const SizedBox(width: AppSpacing.md12),
                      Expanded(child: Text(name, style: Theme.of(context).textTheme.titleMedium)),
                      if (isSystem)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(color: AppColors.muted.withOpacity(0.18), borderRadius: BorderRadius.circular(AppRadius.pill999)),
                          child: const Text('System', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.text2)),
                        ),
                      const SizedBox(width: AppSpacing.sm8),
                      const Icon(Icons.chevron_right, color: AppColors.text3),
                    ],
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// The module × action permission matrix for one role.
class RolePermissionsScreen extends ConsumerStatefulWidget {
  const RolePermissionsScreen({super.key, required this.roleId, required this.roleName, this.isSystem = false});
  final int roleId;
  final String roleName;
  final bool isSystem;

  @override
  ConsumerState<RolePermissionsScreen> createState() => _RolePermissionsScreenState();
}

class _RolePermissionsScreenState extends ConsumerState<RolePermissionsScreen> {
  List<Map<String, dynamic>> _modules = [];
  final Set<String> _granted = {};
  bool _loading = true, _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final api = ref.read(apiClientProvider);
      final avail = await api.get('/account/roles/available-permissions');
      final role = await api.get('/account/roles/${widget.roleId}');
      final mods = (avail is Map && avail['modules'] is List)
          ? (avail['modules'] as List).whereType<Map>().map((m) => m.cast<String, dynamic>()).toList()
          : <Map<String, dynamic>>[];
      final slugs = _slugsOf(role);
      if (!mounted) return;
      setState(() {
        _modules = mods;
        _granted
          ..clear()
          ..addAll(slugs);
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() { _error = e is ApiException ? e.message : 'Could not load permissions.'; _loading = false; });
    }
  }

  List<String> _slugsOf(dynamic role) {
    if (role is! Map) return const [];
    final s = role['slugs'] ?? role['permissions'] ?? role['permission_slugs'];
    if (s is List) return s.map((e) => '$e').toList();
    return const [];
  }

  Future<void> _save() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).put('/account/roles/${widget.roleId}/permissions', body: {'slugs': _granted.toList()});
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Permissions saved.')));
      Navigator.pop(context);
    } on ApiException catch (e) {
      _err(e.message);
    } catch (e) {
      _err('Could not save: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _err(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.roleName)),
      body: _loading
          ? const LoadingState(message: 'Loading permissions…')
          : _error != null
              ? ErrorState(_error!, onRetry: _load)
              : ListView(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
                  children: [
                    if (widget.isSystem)
                      Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.md12),
                        child: Text('System role — changes may be restricted by your licence.',
                            style: Theme.of(context).textTheme.bodySmall),
                      ),
                    for (final m in _modules) _ModuleCard(m, _granted, () => setState(() {})),
                  ],
                ),
      bottomNavigationBar: _loading || _error != null
          ? null
          : SafeArea(
              minimum: const EdgeInsets.all(AppSpacing.md12),
              child: AppButton(label: 'Save Permissions', icon: Icons.save_outlined, loading: _busy, onPressed: _save),
            ),
    );
  }
}

class _ModuleCard extends StatelessWidget {
  const _ModuleCard(this.m, this.granted, this.onChanged);
  final Map<String, dynamic> m;
  final Set<String> granted;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final key = '${m['key'] ?? ''}';
    final label = '${m['label'] ?? key}';
    final actions = (m['actions'] is List) ? (m['actions'] as List).map((a) => '$a').toList() : <String>[];
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          Wrap(
            spacing: AppSpacing.sm8,
            runSpacing: 4,
            children: [
              for (final a in actions)
                FilterChip(
                  label: Text(a),
                  selected: granted.contains('$key.$a'),
                  onSelected: (on) {
                    final slug = '$key.$a';
                    if (on) {
                      granted.add(slug);
                    } else {
                      granted.remove(slug);
                    }
                    onChanged();
                  },
                ),
            ],
          ),
        ],
      ),
      ),
    );
  }
}
