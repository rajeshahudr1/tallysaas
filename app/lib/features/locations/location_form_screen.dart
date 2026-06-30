import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/location_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/form_section.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Location (Tally godown / branch) — mirrors the web
/// `locations/form.ejs` (Name required, Code upper-cased). Sections map to the
/// web's tabs: Basic, Address, Contact & Manager, Custom Fields. State is a
/// STRING dropdown from `GET /config/options`. Submits POST (add) / PUT (edit).
class LocationFormScreen extends ConsumerStatefulWidget {
  const LocationFormScreen({super.key, this.locationId});

  final int? locationId; // null → Add; id → Edit
  bool get isEdit => locationId != null;

  @override
  ConsumerState<LocationFormScreen> createState() => _LocationFormScreenState();
}

class _LocationFormScreenState extends ConsumerState<LocationFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _code = TextEditingController();
  final _city = TextEditingController();
  final _pincode = TextEditingController();
  final _mobile = TextEditingController();
  final _manager = TextEditingController();

  String _status = 'Active';
  String? _state;
  bool _isTallyGodown = true; // web: checked by default on Add
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
    for (final c in [_name, _code, _city, _pincode, _mobile, _manager]) {
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
      final l = await ref.read(locationRepositoryProvider).get(widget.locationId!);
      _name.text = l.name;
      _code.text = l.code ?? '';
      _city.text = l.city ?? '';
      _pincode.text = l.pincode ?? '';
      _mobile.text = l.mobile ?? '';
      _manager.text = l.manager ?? '';
      _state = l.state;
      _status = l.status ?? 'Active';
      _isTallyGodown = l.isTallyGodown ?? false;
      _customFields
        ..clear()
        ..addAll(cfRowsFromMap(l.customFields));
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load location: $e';
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
      if (_code.text.trim().isNotEmpty) 'code': _code.text.trim().toUpperCase(),
      if (_city.text.trim().isNotEmpty) 'city': _city.text.trim(),
      if (_state != null) 'state': _state,
      if (_pincode.text.trim().isNotEmpty) 'pincode': _pincode.text.trim(),
      if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
      if (_manager.text.trim().isNotEmpty) 'manager': _manager.text.trim(),
      'status': _status,
      'is_tally_godown': _isTallyGodown,
      'custom_fields': cfRowsToMap(_customFields),
    };
    try {
      final repo = ref.read(locationRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.locationId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Location updated.' : 'Location created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save location: $e');
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
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Location' : 'Add Location')),
      body: _loading
          ? const LoadingState(message: 'Loading location…')
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
            controller: _name, label: 'Location Name *',
            prefixIcon: Icons.place_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          gap,
          AppTextField(controller: _code, label: 'Location Code'),
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
            title: const Text('Map as Tally godown'),
            subtitle: const Text('Syncs this location to Tally as a godown for location-wise stock.'),
            value: _isTallyGodown,
            onChanged: (v) => setState(() => _isTallyGodown = v),
          ),

          // ════ Address ════
          const FormSectionTitle('Address'),
          AppTextField(controller: _city, label: 'City'),
          gap,
          ConfigDropdown(
            label: 'State', configKey: 'states',
            value: _state, onChanged: (v) => setState(() => _state = v),
          ),
          gap,
          AppTextField(
            controller: _pincode, label: 'Pincode',
            keyboardType: TextInputType.number,
          ),

          // ════ Contact & Manager ════
          const FormSectionTitle('Contact & Manager'),
          AppTextField(
            controller: _mobile, label: 'Mobile',
            keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
          ),
          gap,
          AppTextField(
            controller: _manager, label: 'Manager / In-charge',
            prefixIcon: Icons.person_outline,
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
            label: widget.isEdit ? 'Update Location' : 'Save Location',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}
