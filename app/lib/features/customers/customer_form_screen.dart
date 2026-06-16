import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/models/paged.dart';
import '../../data/repositories/customer_repository.dart';
import '../../data/repositories/options_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Add Customer form. FK dropdowns (Location / Sales Person / Customer Group)
/// are fetched LIVE from the API via `optionsProvider` — nothing hardcoded, so
/// the choices always match the web. Submits `POST /customers`, then pops
/// `true` so the list refreshes.
class CustomerFormScreen extends ConsumerStatefulWidget {
  const CustomerFormScreen({super.key});

  @override
  ConsumerState<CustomerFormScreen> createState() => _CustomerFormScreenState();
}

class _CustomerFormScreenState extends ConsumerState<CustomerFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _mobile = TextEditingController();
  final _email = TextEditingController();
  final _gst = TextEditingController();
  final _opening = TextEditingController();
  final _credit = TextEditingController();

  String _status = 'Active';
  int? _locationId;
  int? _salesPersonId;
  int? _groupId;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _mobile, _email, _gst, _opening, _credit]) {
      c.dispose();
    }
    super.dispose();
  }

  num? _num(String s) => s.trim().isEmpty ? null : num.tryParse(s.trim());

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(customerRepositoryProvider).create({
        'name': _name.text.trim(),
        if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
        if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
        if (_gst.text.trim().isNotEmpty) 'gst_number': _gst.text.trim(),
        if (_num(_opening.text) != null) 'opening_balance': _num(_opening.text),
        if (_num(_credit.text) != null) 'credit_limit': _num(_credit.text),
        'status': _status,
        if (_locationId != null) 'location_id': _locationId,
        if (_salesPersonId != null) 'sales_person_id': _salesPersonId,
        if (_groupId != null) 'customer_group_id': _groupId,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Customer created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create customer: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Customer')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            AppTextField(
              controller: _name, label: 'Customer Name',
              prefixIcon: Icons.person_outline,
              validator: (v) => Validators.required(v, 'Name'),
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _mobile, label: 'Mobile',
              keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _email, label: 'Email',
              keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? null : Validators.email(v),
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _gst, label: 'GST Number'),
            const SizedBox(height: AppSpacing.md12),

            // FK dropdowns — options fetched live from the API.
            _OptionDropdown(
              label: 'Location', endpoint: '/locations',
              value: _locationId, onChanged: (v) => setState(() => _locationId = v),
            ),
            const SizedBox(height: AppSpacing.md12),
            _OptionDropdown(
              label: 'Sales Person', endpoint: '/sales-persons',
              value: _salesPersonId, onChanged: (v) => setState(() => _salesPersonId = v),
            ),
            const SizedBox(height: AppSpacing.md12),
            _OptionDropdown(
              label: 'Customer Group', endpoint: '/customer-groups',
              value: _groupId, onChanged: (v) => setState(() => _groupId = v),
            ),
            const SizedBox(height: AppSpacing.md12),

            Row(
              children: [
                Expanded(child: AppTextField(
                  controller: _opening, label: 'Opening Balance',
                  keyboardType: TextInputType.number,
                )),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(
                  controller: _credit, label: 'Credit Limit',
                  keyboardType: TextInputType.number,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),

            // Status — a fixed lifecycle enum (Active/Inactive/Blocked), the
            // same set the API validates; not "data", so safe to enumerate.
            Text('Status', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            DropdownButtonFormField<String>(
              value: _status,
              items: const ['Active', 'Inactive', 'Blocked']
                  .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                  .toList(),
              onChanged: (v) => setState(() => _status = v ?? 'Active'),
            ),
            const SizedBox(height: AppSpacing.xl24),

            AppButton(label: 'Save Customer', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}

/// A labelled FK dropdown whose options stream from `optionsProvider(endpoint)`.
/// Shows a disabled "Loading…" while fetching and an error hint on failure —
/// never a hardcoded list.
class _OptionDropdown extends ConsumerWidget {
  const _OptionDropdown({
    required this.label,
    required this.endpoint,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final String endpoint;
  final int? value;
  final ValueChanged<int?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(optionsProvider(endpoint));
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        async.when(
          loading: () => const _DropdownShell(child: Text('Loading…')),
          error: (e, _) => _DropdownShell(
            child: Text('Could not load $label', style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<OptionItem> opts) => DropdownButtonFormField<int>(
            value: opts.any((o) => o.id == value) ? value : null,
            isExpanded: true,
            hint: Text('Select ${label.toLowerCase()}'),
            items: opts
                .map((o) => DropdownMenuItem(value: o.id, child: Text(o.name)))
                .toList(),
            onChanged: onChanged,
          ),
        ),
      ],
    );
  }
}

class _DropdownShell extends StatelessWidget {
  const _DropdownShell({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => InputDecorator(
        decoration: const InputDecoration(),
        child: child,
      );
}
