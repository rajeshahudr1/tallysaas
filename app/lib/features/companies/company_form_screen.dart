import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/company_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_section.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Company — mirrors the web `companies/form.ejs` (Name required,
/// GST/PAN upper-cased). Sections map to the web's tabs: Basic, Address, Tax &
/// Statutory, Financial Year, Custom Fields. (The web's Branding tab is a logo
/// file-upload — not part of this mobile form yet.) Submits POST / PUT.
class CompanyFormScreen extends ConsumerStatefulWidget {
  const CompanyFormScreen({super.key, this.companyId});

  final int? companyId; // null → Add; id → Edit
  bool get isEdit => companyId != null;

  @override
  ConsumerState<CompanyFormScreen> createState() => _CompanyFormScreenState();
}

class _CompanyFormScreenState extends ConsumerState<CompanyFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _mailingName = TextEditingController();
  final _email = TextEditingController();
  final _mobile = TextEditingController();
  final _phone = TextEditingController();
  final _address = TextEditingController();
  final _state = TextEditingController();
  final _pincode = TextEditingController();
  final _country = TextEditingController();
  final _gst = TextEditingController();
  final _pan = TextEditingController();
  final _financialYear = TextEditingController();
  final _booksFrom = TextEditingController();

  String _status = 'Active';
  final List<CfRow> _customFields = [];

  bool _busy = false;
  bool _loading = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    if (widget.isEdit) _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _mailingName, _email, _mobile, _phone, _address,
                     _state, _pincode, _country, _gst, _pan, _financialYear, _booksFrom]) {
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
      final c = await ref.read(companyRepositoryProvider).get(widget.companyId!);
      _name.text = c.name;
      _mailingName.text = c.mailingName ?? '';
      _email.text = c.email ?? '';
      _mobile.text = c.mobile ?? '';
      _phone.text = c.phone ?? '';
      _address.text = c.address ?? '';
      _state.text = c.state ?? '';
      _pincode.text = c.pincode ?? '';
      _country.text = c.country ?? '';
      _gst.text = c.gstNumber ?? '';
      _pan.text = c.panNumber ?? '';
      _financialYear.text = c.financialYear ?? '';
      _booksFrom.text = c.booksFrom ?? '';
      _status = c.status ?? 'Active';
      _customFields
        ..clear()
        ..addAll(cfRowsFromMap(c.customFields));
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load company: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      if (_mailingName.text.trim().isNotEmpty) 'mailing_name': _mailingName.text.trim(),
      if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
      if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
      if (_phone.text.trim().isNotEmpty) 'phone': _phone.text.trim(),
      if (_address.text.trim().isNotEmpty) 'address': _address.text.trim(),
      if (_state.text.trim().isNotEmpty) 'state': _state.text.trim(),
      if (_pincode.text.trim().isNotEmpty) 'pincode': _pincode.text.trim(),
      if (_country.text.trim().isNotEmpty) 'country': _country.text.trim(),
      if (_gst.text.trim().isNotEmpty) 'gst_number': _gst.text.trim().toUpperCase(),
      if (_pan.text.trim().isNotEmpty) 'pan_number': _pan.text.trim().toUpperCase(),
      if (_financialYear.text.trim().isNotEmpty) 'financial_year': _financialYear.text.trim(),
      if (_booksFrom.text.trim().isNotEmpty) 'books_from': _booksFrom.text.trim(),
      'status': _status,
      'custom_fields': cfRowsToMap(_customFields),
    };
    try {
      final repo = ref.read(companyRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.companyId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Company updated.' : 'Company created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save company: $e');
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
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Company' : 'Add Company')),
      body: _loading
          ? const LoadingState(message: 'Loading company…')
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
            controller: _name, label: 'Company Name *',
            prefixIcon: Icons.business_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          gap,
          AppTextField(controller: _mailingName, label: 'Mailing Name'),
          gap,
          AppTextField(
            controller: _email, label: 'Email',
            keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
            validator: (v) => (v == null || v.trim().isEmpty) ? null : Validators.email(v),
          ),
          gap,
          Row(
            children: [
              Expanded(child: AppTextField(
                controller: _mobile, label: 'Mobile',
                keyboardType: TextInputType.phone,
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: AppTextField(
                controller: _phone, label: 'Phone (Landline)',
                keyboardType: TextInputType.phone,
              )),
            ],
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

          // ════ Address ════
          const FormSectionTitle('Address'),
          AppTextField(controller: _address, label: 'Street Address', maxLines: 3),
          gap,
          AppTextField(controller: _state, label: 'State'),
          gap,
          Row(
            children: [
              Expanded(child: AppTextField(
                controller: _pincode, label: 'Pincode',
                keyboardType: TextInputType.number,
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: AppTextField(controller: _country, label: 'Country')),
            ],
          ),

          // ════ Tax & Statutory ════
          const FormSectionTitle('Tax & Statutory'),
          AppTextField(controller: _gst, label: 'GST Number', hint: '24ABCDE1234F1Z5'),
          gap,
          AppTextField(controller: _pan, label: 'PAN Number', hint: 'ABCDE1234F'),

          // ════ Financial Year ════
          const FormSectionTitle('Financial Year'),
          AppTextField(controller: _financialYear, label: 'Financial Year', hint: '2024-2025'),
          gap,
          AppTextField(controller: _booksFrom, label: 'Books Beginning From', hint: '2024-04-01'),

          // ════ Custom Fields ════
          const FormSectionTitle('Custom Fields'),
          CustomFieldsEditor(
            rows: _customFields,
            onAdd: () => setState(() => _customFields.add(CfRow('', ''))),
            onRemove: (i) => setState(() => _customFields.removeAt(i).dispose()),
          ),

          const SizedBox(height: AppSpacing.xl24),
          AppButton(
            label: widget.isEdit ? 'Update Company' : 'Save Company',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}
