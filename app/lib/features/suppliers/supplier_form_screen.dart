import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/supplier_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/form_section.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Supplier (Tally sundry creditor) — mirrors the web
/// `suppliers/form.ejs` field-for-field + its validation (Name + Location
/// required, email format, GST/PAN upper-cased). Sections map to the web's tabs:
/// Basic, Address, GST & Tax, Other, Custom Fields. Location is an FK dropdown;
/// Supplier Group + Payment Terms are STRING dropdowns from `GET /config/options`
/// (single source shared with the web). Submits POST (add) / PUT (edit).
class SupplierFormScreen extends ConsumerStatefulWidget {
  const SupplierFormScreen({super.key, this.supplierId});

  final int? supplierId; // null → Add; id → Edit
  bool get isEdit => supplierId != null;

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
  final _address = TextEditingController();
  final _opening = TextEditingController();
  final _creditDays = TextEditingController();

  String _status = 'Active';
  int? _locationId;
  String? _supplierGroup;
  String? _paymentTerms;
  bool _isTallyLedger = true; // web: checked by default on Add (Sundry Creditor)
  final List<CfRow> _customFields = [];

  bool _busy = false; // saving
  bool _loading = false; // fetching the row for Edit
  String? _loadError;

  @override
  void initState() {
    super.initState();
    if (widget.isEdit) _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _mobile, _altMobile, _email, _gst, _pan, _address,
                     _opening, _creditDays]) {
      c.dispose();
    }
    for (final r in _customFields) {
      r.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _loadError = null; });
    try {
      final s = await ref.read(supplierRepositoryProvider).get(widget.supplierId!);
      _name.text = s.name;
      _mobile.text = s.mobile ?? '';
      _altMobile.text = s.alternateMobile ?? '';
      _email.text = s.email ?? '';
      _gst.text = s.gstNumber ?? '';
      _pan.text = s.panNumber ?? '';
      _address.text = s.address ?? '';
      _opening.text = s.openingBalance?.toString() ?? '';
      _creditDays.text = s.creditDays?.toString() ?? '';
      _status = s.status ?? 'Active';
      _locationId = s.locationId;
      _supplierGroup = s.supplierGroup;
      _paymentTerms = s.paymentTerms;
      _isTallyLedger = s.isTallyLedger ?? false;
      _customFields
        ..clear()
        ..addAll(cfRowsFromMap(s.customFields));
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load supplier: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  num? _num(String s) => s.trim().isEmpty ? null : num.tryParse(s.trim());

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
      if (_altMobile.text.trim().isNotEmpty) 'alternate_mobile': _altMobile.text.trim(),
      if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
      if (_gst.text.trim().isNotEmpty) 'gst_number': _gst.text.trim().toUpperCase(),
      if (_pan.text.trim().isNotEmpty) 'pan_number': _pan.text.trim().toUpperCase(),
      if (_address.text.trim().isNotEmpty) 'address': _address.text.trim(),
      if (_supplierGroup != null) 'supplier_group': _supplierGroup,
      if (_locationId != null) 'location_id': _locationId,
      if (_num(_opening.text) != null) 'opening_balance': _num(_opening.text),
      // Only sent when filled: an empty box means no agreed terms, and
      // sending 0 would record a same-day term nobody agreed to.
      if (_num(_creditDays.text) != null) 'credit_days': _num(_creditDays.text),
      if (_paymentTerms != null) 'payment_terms': _paymentTerms,
      'status': _status,
      'is_tally_ledger': _isTallyLedger,
      'custom_fields': cfRowsToMap(_customFields),
    };
    try {
      final repo = ref.read(supplierRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.supplierId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Supplier updated.' : 'Supplier created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save supplier: $e');
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
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Supplier' : 'Add Supplier')),
      body: _loading
          ? const LoadingState(message: 'Loading supplier…')
          : _loadError != null
              ? ErrorState(_loadError!, onRetry: _load)
              : _buildForm(context),
    );
  }

  Widget _buildForm(BuildContext context) {
    const gap = SizedBox(height: AppSpacing.md12);
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          // ════ Basic Information ════
          const FormSectionTitle('Basic Information', first: true),
          AppTextField(
            controller: _name, label: 'Supplier Name *',
            prefixIcon: Icons.storefront_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          gap,
          AppTextField(
            controller: _mobile, label: 'Mobile',
            keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
          ),
          gap,
          AppTextField(
            controller: _altMobile, label: 'Alternate Mobile',
            keyboardType: TextInputType.phone, prefixIcon: Icons.phone_android_outlined,
          ),
          gap,
          ConfigDropdown(
            label: 'Supplier Group', configKey: 'supplier_groups',
            value: _supplierGroup, onChanged: (v) => setState(() => _supplierGroup = v),
          ),
          gap,
          AppTextField(
            controller: _email, label: 'Email',
            keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
            validator: (v) => (v == null || v.trim().isEmpty) ? null : Validators.email(v),
          ),
          gap,
          FkDropdown(
            label: 'Location *', endpoint: '/locations',
            value: _locationId, onChanged: (v) => setState(() => _locationId = v),
            validator: (v) => v == null ? 'Location is required' : null,
          ),
          gap,
          Text('Status *', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          DropdownButtonFormField<String>(
            value: _status,
            items: const ['Active', 'Inactive', 'Blocked']
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: (v) => setState(() => _status = v ?? 'Active'),
          ),
          const SizedBox(height: AppSpacing.sm8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Sundry Creditor (Tally ledger)'),
            subtitle: const Text('Creates this supplier under Sundry Creditors in Tally.'),
            value: _isTallyLedger,
            onChanged: (v) => setState(() => _isTallyLedger = v),
          ),

          // ════ Address ════
          const FormSectionTitle('Address'),
          AppTextField(controller: _address, label: 'Address', maxLines: 4),

          // ════ GST & Tax Details ════
          const FormSectionTitle('GST & Tax Details'),
          AppTextField(controller: _gst, label: 'GST Number', hint: '24ABCDE1234F1Z5'),
          gap,
          AppTextField(controller: _pan, label: 'PAN Number', hint: 'ABCDE1234F'),

          // ════ Other Details ════
          const FormSectionTitle('Other Details'),
          AppTextField(
            controller: _opening, label: 'Opening Balance — Payable (₹)',
            keyboardType: TextInputType.number,
          ),
          gap,
          ConfigDropdown(
            label: 'Payment Terms', configKey: 'payment_terms',
            value: _paymentTerms, onChanged: (v) => setState(() => _paymentTerms = v),
          ),
          gap,
          // The credit period as a NUMBER, alongside the free-text terms.
          // Blank means "no agreed terms" — not zero days.
          AppTextField(
            controller: _creditDays, label: 'Credit Days',
            keyboardType: TextInputType.number,
          ),

          // ════ Custom Fields ════
          const FormSectionTitle('Custom Fields'),
          CustomFieldsEditor(
            rows: _customFields,
            onAdd: () => setState(() => _customFields.add(CfRow('', ''))),
            onRemove: (i) => setState(() => _customFields.removeAt(i).dispose()),
          ),

          const SizedBox(height: AppSpacing.xl24),
          AppButton(
            label: widget.isEdit ? 'Update Supplier' : 'Save Supplier',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}
