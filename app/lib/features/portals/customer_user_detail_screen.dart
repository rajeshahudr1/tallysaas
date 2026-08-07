import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../data/models/portal_user.dart';
import '../../data/repositories/portal_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/loading_state.dart';

/// One customer's portal access: the login, and the catalog that decides which
/// categories they see and at what price.
///
/// Password rule mirrors the API: required only when the login is brand new;
/// left blank on an existing login it stays unchanged.
class CustomerUserDetailScreen extends ConsumerStatefulWidget {
  const CustomerUserDetailScreen({super.key, required this.customerId});
  final int customerId;

  @override
  ConsumerState<CustomerUserDetailScreen> createState() =>
      _CustomerUserDetailScreenState();
}

class _CustomerUserDetailScreenState extends ConsumerState<CustomerUserDetailScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();

  int? _roleId;
  String _status = 'Active';
  bool _hasLogin = false;

  List<CatalogEntry> _catalog = const [];

  bool _loading = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await ref.read(portalRepositoryProvider).assignments(widget.customerId);
      if (!mounted) return;
      final user = (data['user'] is Map)
          ? (data['user'] as Map).cast<String, dynamic>()
          : null;
      setState(() {
        _hasLogin = user != null;
        _email.text = (user?['email'] ?? '').toString();
        _roleId = user == null ? null : int.tryParse('${user['role_id']}');
        _status = (user?['status'] ?? 'Active').toString();
        _catalog = (data['categories'] is List)
            ? (data['categories'] as List)
                .whereType<Map>()
                .map((m) => CatalogEntry.fromJson(m.cast<String, dynamic>()))
                .toList(growable: false)
            : const [];
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _loading = false; });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Could not load this customer’s portal access.';
          _loading = false;
        });
      }
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _saveLogin() async {
    if (_busy) return;
    if (_email.text.trim().isEmpty) {
      _snack('A login email is required.');
      return;
    }
    if (_roleId == null) {
      _snack('Pick the role this login gets.');
      return;
    }
    if (!_hasLogin && _password.text.isEmpty) {
      _snack('A password is required for a new login.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(portalRepositoryProvider).setLogin(
            widget.customerId,
            email: _email.text,
            password: _password.text.isEmpty ? null : _password.text,
            roleId: _roleId!,
            status: _status,
          );
      _password.clear();
      _snack(_hasLogin ? 'Login updated.' : 'Portal login created.');
      await _load();
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save the login.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can('customer-users', 'edit') ?? false;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Portal Access')),
      body: _error != null
          ? ErrorState(_error!, onRetry: _load)
          : _loading
              ? const LoadingState(message: 'Loading portal access…')
              : ListView(
                  padding: const EdgeInsets.all(AppSpacing.lg16),
                  children: [
                    const DetailSection('Login', first: true),
                    AppTextField(
                      controller: _email,
                      label: 'Login email *',
                      enabled: canEdit,
                    ),
                    const SizedBox(height: AppSpacing.md12),
                    AppTextField(
                      controller: _password,
                      label: _hasLogin ? 'New password' : 'Password *',
                      hint: _hasLogin ? 'Leave blank to keep the current one' : null,
                      obscure: true,
                      enabled: canEdit,
                    ),
                    const SizedBox(height: AppSpacing.md12),
                    FkDropdown(
                      label: 'Role *',
                      endpoint: '/roles',
                      value: _roleId,
                      onChanged: canEdit ? (v) => setState(() => _roleId = v) : (_) {},
                    ),
                    const SizedBox(height: AppSpacing.md12),
                    DropdownButtonFormField<String>(
                      value: _status,
                      decoration: const InputDecoration(labelText: 'Status'),
                      items: const [
                        DropdownMenuItem(value: 'Active', child: Text('Active')),
                        DropdownMenuItem(value: 'Inactive', child: Text('Inactive')),
                        DropdownMenuItem(value: 'Blocked', child: Text('Blocked')),
                      ],
                      onChanged:
                          canEdit ? (v) => setState(() => _status = v ?? 'Active') : null,
                    ),
                    if (canEdit) ...[
                      const SizedBox(height: AppSpacing.lg16),
                      AppButton(
                        label: _hasLogin ? 'Update Login' : 'Create Login',
                        loading: _busy,
                        onPressed: _saveLogin,
                      ),
                    ],

                    DetailSection('Catalog (${_catalog.length} categories)'),
                    if (_catalog.isEmpty)
                      Text(
                        'No catalog scoping yet — this login sees the standard '
                        'catalog and prices. Category pricing is set on the web '
                        'for now.',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: AppColors.text3),
                      )
                    else
                      for (final c in _catalog) ...[
                        AppCard(
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  c.categoryName ?? 'Category #${c.categoryId}',
                                  style: theme.textTheme.titleMedium,
                                ),
                              ),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    // A category carries a discount OR an
                                    // addition — never both (the API rejects it).
                                    c.discountPct > 0
                                        ? '−${c.discountPct}%'
                                        : c.additionPct > 0
                                            ? '+${c.additionPct}%'
                                            : 'List price',
                                    style: theme.textTheme.titleSmall,
                                  ),
                                  const SizedBox(height: 2),
                                  Text('${c.productIds.length} items',
                                      style: theme.textTheme.bodySmall),
                                ],
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: AppSpacing.sm8),
                      ],
                  ],
                ),
    );
  }
}
