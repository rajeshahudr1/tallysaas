import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/location_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Add Location (Tally godown / branch) form. No FK fields — plain address
/// columns. Submits `POST /locations`, then pops `true` so the list refreshes.
class LocationFormScreen extends ConsumerStatefulWidget {
  const LocationFormScreen({super.key});

  @override
  ConsumerState<LocationFormScreen> createState() => _LocationFormScreenState();
}

class _LocationFormScreenState extends ConsumerState<LocationFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _code = TextEditingController();
  final _city = TextEditingController();
  final _state = TextEditingController();
  final _pincode = TextEditingController();
  final _mobile = TextEditingController();
  final _manager = TextEditingController();

  String _status = 'Active';
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _code, _city, _state, _pincode, _mobile, _manager]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(locationRepositoryProvider).create({
        'name': _name.text.trim(),
        if (_code.text.trim().isNotEmpty) 'code': _code.text.trim(),
        if (_city.text.trim().isNotEmpty) 'city': _city.text.trim(),
        if (_state.text.trim().isNotEmpty) 'state': _state.text.trim(),
        if (_pincode.text.trim().isNotEmpty) 'pincode': _pincode.text.trim(),
        if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
        if (_manager.text.trim().isNotEmpty) 'manager': _manager.text.trim(),
        'status': _status,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Location created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create location: $e');
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
      appBar: AppBar(title: const Text('Add Location')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            AppTextField(
              controller: _name, label: 'Location Name',
              prefixIcon: Icons.place_outlined,
              validator: (v) => Validators.required(v, 'Name'),
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(controller: _code, label: 'Code')),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(
                  controller: _pincode, label: 'Pincode',
                  keyboardType: TextInputType.number,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(controller: _city, label: 'City')),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(controller: _state, label: 'State')),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _mobile, label: 'Mobile',
              keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _manager, label: 'Manager',
              prefixIcon: Icons.person_outline,
            ),
            const SizedBox(height: AppSpacing.md12),

            Text('Status', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            DropdownButtonFormField<String>(
              value: _status,
              items: const ['Active', 'Inactive']
                  .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                  .toList(),
              onChanged: (v) => setState(() => _status = v ?? 'Active'),
            ),
            const SizedBox(height: AppSpacing.xl24),

            AppButton(label: 'Save Location', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}
