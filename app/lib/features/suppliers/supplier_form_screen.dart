import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/supplier_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';

/// Add Supplier form. Location is an FK dropdown (`/locations`, id+name);
/// Supplier Group + Payment Terms are STRING dropdowns whose choices come from
/// `GET /config/options` — the single source shared with the web, nothing
/// hardcoded. Submits `POST /suppliers`, then pops `true` so the list refreshes.
class SupplierFormScreen extends ConsumerStatefulWidget {
  const SupplierFormScreen({super.key});

  @override
  ConsumerState<SupplierFormScreen> createState() => _SupplierFormScreenState();
}

class _SupplierFormScreenState extends ConsumerState<SupplierFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _mobile = TextEditingController();
  final _altMobile = TextEditingController();
  final _email = TextEditingController();
  final _gst = TextEditingController();
  final _pan = TextEditingController();
  final _opening = TextEditingController();

  String _status = 'Active';
  int? _locationId;
  String? _supplierGroup;
  String? _paymentTerms;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _mobile, _altMobile, _email, _gst, _pan, _opening]) {
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
      await ref.read(supplierRepositoryProvider).create({
        'name': _name.text.trim(),
        if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
        if (_altMobile.text.trim().isNotEmpty) 'alternate_mobile': _altMobile.text.trim(),
        if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
        if (_gst.text.trim().isNotEmpty) 'gst_number': _gst.text.trim(),
        if (_pan.text.trim().isNotEmpty) 'pan_number': _pan.text.trim(),
        if (_supplierGroup != null) 'supplier_group': _supplierGroup,
        if (_locationId != null) 'location_id': _locationId,
        if (_num(_opening.text) != null) 'opening_balance': _num(_opening.text),
        if (_paymentTerms != null) 'payment_terms': _paymentTerms,
        'status': _status,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Supplier created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create supplier: $e');
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
      appBar: AppBar(title: const Text('Add Supplier')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            AppTextField(
              controller: _name, label: 'Supplier Name',
              prefixIcon: Icons.storefront_outlined,
              validator: (v) => Validators.required(v, 'Name'),
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(
                  controller: _mobile, label: 'Mobile',
                  keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
                )),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(
                  controller: _altMobile, label: 'Alt. Mobile',
                  keyboardType: TextInputType.phone,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _email, label: 'Email',
              keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? null : Validators.email(v),
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(controller: _gst, label: 'GST Number')),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(controller: _pan, label: 'PAN Number')),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),

            // FK dropdown — options fetched live from /locations.
            FkDropdown(
              label: 'Location', endpoint: '/locations',
              value: _locationId, onChanged: (v) => setState(() => _locationId = v),
            ),
            const SizedBox(height: AppSpacing.md12),

            // String dropdowns — choices from GET /config/options (single source).
            ConfigDropdown(
              label: 'Supplier Group', configKey: 'supplier_groups',
              value: _supplierGroup, onChanged: (v) => setState(() => _supplierGroup = v),
            ),
            const SizedBox(height: AppSpacing.md12),
            ConfigDropdown(
              label: 'Payment Terms', configKey: 'payment_terms',
              value: _paymentTerms, onChanged: (v) => setState(() => _paymentTerms = v),
            ),
            const SizedBox(height: AppSpacing.md12),

            AppTextField(
              controller: _opening, label: 'Opening Balance (Payable)',
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: AppSpacing.md12),

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

            AppButton(label: 'Save Supplier', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}
