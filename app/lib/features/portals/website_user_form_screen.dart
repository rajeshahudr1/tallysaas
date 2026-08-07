import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/repositories/portal_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/loading_state.dart';

/// Create / edit a website user (third-party API consumer).
///
/// On create the API returns the api_token ONCE — it is shown in a copyable
/// dialog straight away, because it is never retrievable afterwards.
class WebsiteUserFormScreen extends ConsumerStatefulWidget {
  const WebsiteUserFormScreen({super.key, this.userId});

  /// Null → create; set → edit that website user.
  final int? userId;

  @override
  ConsumerState<WebsiteUserFormScreen> createState() => _WebsiteUserFormScreenState();
}

class _WebsiteUserFormScreenState extends ConsumerState<WebsiteUserFormScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _mobile = TextEditingController();
  final _cashPct = TextEditingController(text: '0');
  final _onlinePct = TextEditingController(text: '0');

  int? _roleId;
  String _status = 'Active';

  bool _loading = false;
  bool _busy = false;
  String? _loadError;

  bool get _isEdit => widget.userId != null;

  @override
  void initState() {
    super.initState();
    if (_isEdit) _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _email, _password, _mobile, _cashPct, _onlinePct]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final u = await ref.read(portalRepositoryProvider).websiteUser(widget.userId!);
      if (!mounted) return;
      setState(() {
        _name.text = u.name;
        _email.text = u.email ?? '';
        _mobile.text = u.mobile ?? '';
        _cashPct.text = '${u.cashExtraPct ?? 0}';
        _onlinePct.text = '${u.onlineExtraPct ?? 0}';
        _status = u.status ?? 'Active';
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _loadError = e.message; _loading = false; });
    } catch (_) {
      if (mounted) {
        setState(() {
          _loadError = 'Could not load this website user.';
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

  Future<void> _showToken(String token) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('API token'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(token),
            const SizedBox(height: AppSpacing.sm8),
            Text('Copy it now — it is not shown again.',
                style: Theme.of(ctx).textTheme.bodySmall),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: token));
              if (ctx.mounted) Navigator.pop(ctx);
              _snack('Token copied.');
            },
            child: const Text('Copy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_name.text.trim().isEmpty || _email.text.trim().isEmpty) {
      _snack('Name and email are required.');
      return;
    }
    if (!_isEdit && _password.text.length < 8) {
      _snack('A password of at least 8 characters is required.');
      return;
    }
    if (!_isEdit && _roleId == null) {
      _snack('Pick the role this login gets.');
      return;
    }

    final body = <String, dynamic>{
      'name': _name.text.trim(),
      'email': _email.text.trim(),
      if (_password.text.isNotEmpty) 'password': _password.text,
      if (_roleId != null) 'role_id': _roleId,
      'mobile': _mobile.text.trim(),
      'cash_extra_pct': double.tryParse(_cashPct.text.trim()) ?? 0,
      'online_extra_pct': double.tryParse(_onlinePct.text.trim()) ?? 0,
      'status': _status,
    };

    setState(() => _busy = true);
    try {
      final repo = ref.read(portalRepositoryProvider);
      if (_isEdit) {
        await repo.updateWebsiteUser(widget.userId!, body);
      } else {
        final created = await repo.createWebsiteUser(body);
        if (created.apiToken != null && mounted) {
          await _showToken(created.apiToken!);
        }
      }
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save this website user.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = _isEdit ? 'Edit Website User' : 'New Website User';
    if (_loading) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: const LoadingState(message: 'Loading…'),
      );
    }
    if (_loadError != null) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: ErrorState(_loadError!, onRetry: _load),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          AppTextField(controller: _name, label: 'Name *'),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _email,
            label: 'Login email *',
            keyboardType: TextInputType.emailAddress,
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _password,
            label: _isEdit ? 'New password' : 'Password *',
            hint: _isEdit ? 'Leave blank to keep the current one' : 'Min 8 characters',
            obscure: true,
          ),
          const SizedBox(height: AppSpacing.md12),
          FkDropdown(
            label: _isEdit ? 'Role' : 'Role *',
            endpoint: '/roles',
            value: _roleId,
            onChanged: (v) => setState(() => _roleId = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _mobile,
            label: 'Mobile',
            keyboardType: TextInputType.phone,
          ),
          const SizedBox(height: AppSpacing.md12),
          Row(
            children: [
              Expanded(
                child: AppTextField(
                  controller: _cashPct,
                  label: 'Cash extra %',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                ),
              ),
              const SizedBox(width: AppSpacing.md12),
              Expanded(
                child: AppTextField(
                  controller: _onlinePct,
                  label: 'Online extra %',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                ),
              ),
            ],
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
            onChanged: (v) => setState(() => _status = v ?? 'Active'),
          ),
          const SizedBox(height: AppSpacing.lg16),
          AppButton(
            label: _isEdit ? 'Update Website User' : 'Create Website User',
            loading: _busy,
            onPressed: _save,
          ),
        ],
      ),
    );
  }
}
