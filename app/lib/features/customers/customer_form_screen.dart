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
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Customer — mirrors the web `customers/form.ejs` field-for-field
/// and its validation (Name + Location required, email format, GST/PAN
/// upper-cased). Sections map to the web's tabs: Basic Information, Address,
/// GST & Tax, Other Details, Custom Fields. FK dropdowns stream live from the
/// API so the choices always match the web. Submits `POST /customers` (add) or
/// `PUT /customers/:id` (edit), then pops `true` so the list refreshes.
class CustomerFormScreen extends ConsumerStatefulWidget {
  const CustomerFormScreen({super.key, this.customerId});

  /// null → Add mode; a row id → Edit mode (the row is fetched + pre-filled).
  final int? customerId;
  bool get isEdit => customerId != null;

  @override
  ConsumerState<CustomerFormScreen> createState() => _CustomerFormScreenState();
}

class _CustomerFormScreenState extends ConsumerState<CustomerFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _mobile = TextEditingController();
  final _altMobile = TextEditingController();
  final _email = TextEditingController();
  final _gst = TextEditingController();
  final _pan = TextEditingController();
  final _shipping = TextEditingController();
  final _billing = TextEditingController();
  final _opening = TextEditingController();
  final _credit = TextEditingController();
  final _notes = TextEditingController();
  final _remarks = TextEditingController();

  String _status = 'Active';
  int? _locationId;
  int? _salesPersonId;
  int? _groupId;
  bool _isTallyLedger = true; // web: checked by default on Add
  bool _sameAsShipping = false;
  final List<_CfRow> _customFields = [];

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
    for (final c in [_name, _mobile, _altMobile, _email, _gst, _pan, _shipping,
                     _billing, _opening, _credit, _notes, _remarks]) {
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
      final c = await ref.read(customerRepositoryProvider).get(widget.customerId!);
      _name.text = c.name;
      _mobile.text = c.mobile ?? '';
      _altMobile.text = c.alternateMobile ?? '';
      _email.text = c.email ?? '';
      _gst.text = c.gstNumber ?? '';
      _pan.text = c.panNumber ?? '';
      _shipping.text = c.shippingAddress ?? '';
      _billing.text = c.billingAddress ?? '';
      _opening.text = c.openingBalance?.toString() ?? '';
      _credit.text = c.creditLimit?.toString() ?? '';
      _notes.text = c.notes ?? '';
      _remarks.text = c.internalRemarks ?? '';
      _status = c.status ?? 'Active';
      _locationId = c.locationId;
      _salesPersonId = c.salesPersonId;
      _groupId = c.customerGroupId;
      _isTallyLedger = c.isTallyLedger ?? false;
      _customFields
        ..clear()
        ..addAll(c.customFields.entries.map((e) =>
            _CfRow(e.key, e.value?.toString() ?? '')));
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load customer: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  num? _num(String s) => s.trim().isEmpty ? null : num.tryParse(s.trim());

  Map<String, dynamic> _cfMap() {
    final m = <String, dynamic>{};
    for (final r in _customFields) {
      final k = r.keyCtl.text.trim();
      if (k.isNotEmpty) m[k] = r.valueCtl.text.trim();
    }
    return m;
  }

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
      if (_shipping.text.trim().isNotEmpty) 'shipping_address': _shipping.text.trim(),
      if (_billing.text.trim().isNotEmpty) 'billing_address': _billing.text.trim(),
      if (_num(_opening.text) != null) 'opening_balance': _num(_opening.text),
      if (_num(_credit.text) != null) 'credit_limit': _num(_credit.text),
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      if (_remarks.text.trim().isNotEmpty) 'internal_remarks': _remarks.text.trim(),
      'status': _status,
      'is_tally_ledger': _isTallyLedger,
      if (_locationId != null) 'location_id': _locationId,
      if (_salesPersonId != null) 'sales_person_id': _salesPersonId,
      if (_groupId != null) 'customer_group_id': _groupId,
      'custom_fields': _cfMap(),
    };
    try {
      final repo = ref.read(customerRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.customerId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Customer updated.' : 'Customer created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save customer: $e');
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
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Customer' : 'Add Customer')),
      body: _loading
          ? const LoadingState(message: 'Loading customer…')
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
          const _SectionTitle('Basic Information'),
          AppTextField(
            controller: _name, label: 'Customer Name *',
            prefixIcon: Icons.person_outline,
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
          _OptionDropdown(
            label: 'Customer Group', endpoint: '/customer-groups',
            value: _groupId, onChanged: (v) => setState(() => _groupId = v),
          ),
          gap,
          AppTextField(
            controller: _email, label: 'Email',
            keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
            validator: (v) => (v == null || v.trim().isEmpty) ? null : Validators.email(v),
          ),
          gap,
          _OptionDropdown(
            label: 'Location *', endpoint: '/locations',
            value: _locationId, onChanged: (v) => setState(() => _locationId = v),
            validator: (v) => v == null ? 'Location is required' : null,
          ),
          gap,
          _OptionDropdown(
            label: 'Sales Person', endpoint: '/sales-persons',
            value: _salesPersonId, onChanged: (v) => setState(() => _salesPersonId = v),
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
            title: const Text('Create as Tally ledger'),
            subtitle: const Text('Syncs this customer to Tally as a ledger account.'),
            value: _isTallyLedger,
            onChanged: (v) => setState(() => _isTallyLedger = v),
          ),

          // ════ Address ════
          const _SectionTitle('Address'),
          AppTextField(controller: _shipping, label: 'Shipping Address', maxLines: 3),
          const SizedBox(height: AppSpacing.sm8),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            dense: true,
            title: const Text('Billing same as Shipping'),
            value: _sameAsShipping,
            onChanged: (v) => setState(() {
              _sameAsShipping = v ?? false;
              if (_sameAsShipping) _billing.text = _shipping.text;
            }),
          ),
          AppTextField(controller: _billing, label: 'Billing Address', maxLines: 3),

          // ════ GST & Tax Details ════
          const _SectionTitle('GST & Tax Details'),
          AppTextField(controller: _gst, label: 'GST Number', hint: '24ABCDE1234F1Z5'),
          gap,
          AppTextField(controller: _pan, label: 'PAN Number', hint: 'ABCDE1234F'),

          // ════ Other Details ════
          const _SectionTitle('Other Details'),
          Row(
            children: [
              Expanded(child: AppTextField(
                controller: _credit, label: 'Credit Limit (₹)',
                keyboardType: TextInputType.number,
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: AppTextField(
                controller: _opening, label: 'Opening Balance (₹)',
                keyboardType: TextInputType.number,
              )),
            ],
          ),
          gap,
          AppTextField(controller: _notes, label: 'Notes', maxLines: 3),
          gap,
          AppTextField(controller: _remarks, label: 'Internal Remarks', maxLines: 3),

          // ════ Custom Fields ════
          const _SectionTitle('Custom Fields'),
          for (var i = 0; i < _customFields.length; i++) ...[
            _CustomFieldRow(
              row: _customFields[i],
              onRemove: () => setState(() => _customFields.removeAt(i).dispose()),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => setState(() => _customFields.add(_CfRow('', ''))),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Add field'),
            ),
          ),

          const SizedBox(height: AppSpacing.xl24),
          AppButton(
            label: widget.isEdit ? 'Update Customer' : 'Save Customer',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}

/// Section header that mirrors a web form tab (Basic Information, Address, …).
class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: AppSpacing.lg16, bottom: AppSpacing.sm8),
        child: Text(text,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppColors.primary, fontWeight: FontWeight.w700)),
      );
}

/// One custom-field key/value editor row with a remove button.
class _CfRow {
  _CfRow(String k, String v)
      : keyCtl = TextEditingController(text: k),
        valueCtl = TextEditingController(text: v);
  final TextEditingController keyCtl;
  final TextEditingController valueCtl;
  void dispose() { keyCtl.dispose(); valueCtl.dispose(); }
}

class _CustomFieldRow extends StatelessWidget {
  const _CustomFieldRow({required this.row, required this.onRemove});
  final _CfRow row;
  final VoidCallback onRemove;
  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: AppTextField(controller: row.keyCtl, hint: 'Field name')),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(child: AppTextField(controller: row.valueCtl, hint: 'Value')),
          IconButton(
            onPressed: onRemove,
            icon: const Icon(Icons.close, color: AppColors.danger),
            tooltip: 'Remove',
          ),
        ],
      );
}

/// A labelled FK dropdown whose options stream from `optionsProvider(endpoint)`.
/// Shows a disabled "Loading…" while fetching and an error hint on failure —
/// never a hardcoded list. Pass [validator] to make the field required.
class _OptionDropdown extends ConsumerWidget {
  const _OptionDropdown({
    required this.label,
    required this.endpoint,
    required this.value,
    required this.onChanged,
    this.validator,
  });

  final String label;
  final String endpoint;
  final int? value;
  final ValueChanged<int?> onChanged;
  final String? Function(int?)? validator;

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
            child: Text('Could not load $label',
                style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<OptionItem> opts) => DropdownButtonFormField<int>(
            value: opts.any((o) => o.id == value) ? value : null,
            isExpanded: true,
            hint: Text('Select ${label.replaceAll(' *', '').toLowerCase()}'),
            items: opts
                .map((o) => DropdownMenuItem(value: o.id, child: Text(o.name)))
                .toList(),
            onChanged: onChanged,
            validator: validator,
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
