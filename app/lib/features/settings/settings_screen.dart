import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/models/settings.dart';
import '../../data/repositories/settings_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Company Settings — edits the profile slice the API exposes (name / email /
/// mobile / GST / PAN / financial year / address). `GET /settings` seeds the
/// form once; Save PUTs the `company` patch back. The free-form `settings`
/// key/value bag is loaded but has no fixed UI here, so it round-trips
/// untouched (the screen only sends the `company` half).
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _mobile = TextEditingController();
  final _gst = TextEditingController();
  final _pan = TextEditingController();
  final _financialYear = TextEditingController();
  final _address = TextEditingController();

  /// Seed the controllers exactly once when the async load first lands so
  /// later rebuilds (or a Save) don't clobber in-progress edits.
  bool _seeded = false;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [
      _name,
      _email,
      _mobile,
      _gst,
      _pan,
      _financialYear,
      _address,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  void _seed(CompanyProfile c) {
    if (_seeded) return;
    _seeded = true;
    _name.text = c.name;
    _email.text = c.email ?? '';
    _mobile.text = c.mobile ?? '';
    _gst.text = c.gstNumber ?? '';
    _pan.text = c.panNumber ?? '';
    _financialYear.text = c.financialYear ?? '';
    _address.text = c.address ?? '';
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      // Send the editable company columns. Trimmed; blanked optionals go as
      // empty strings (the controller patches every key it's handed).
      await ref.read(settingsRepositoryProvider).update({
        'company': {
          'name': _name.text.trim(),
          'email': _email.text.trim(),
          'mobile': _mobile.text.trim(),
          'gst_number': _gst.text.trim(),
          'pan_number': _pan.text.trim(),
          'financial_year': _financialYear.text.trim(),
          'address': _address.text.trim(),
        },
      });
      if (!mounted) return;
      // Refresh so a re-entry reflects the saved values.
      ref.invalidate(settingsProvider);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Settings saved.')));
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save settings: $e');
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
    final async = ref.watch(settingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading settings…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load settings.',
          onRetry: () => ref.invalidate(settingsProvider),
        ),
        data: (settings) {
          _seed(settings.company);
          return Form(
            key: _formKey,
            autovalidateMode: AutovalidateMode.onUserInteraction,
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.lg16),
              children: [
                Text(
                  'Company Profile',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.md12),

                AppTextField(
                  controller: _name,
                  label: 'Company Name',
                  prefixIcon: Icons.business_outlined,
                  validator: (v) => Validators.required(v, 'Company name'),
                ),
                const SizedBox(height: AppSpacing.md12),

                AppTextField(
                  controller: _email,
                  label: 'Email',
                  keyboardType: TextInputType.emailAddress,
                  prefixIcon: Icons.email_outlined,
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? null : Validators.email(v),
                ),
                const SizedBox(height: AppSpacing.md12),

                AppTextField(
                  controller: _mobile,
                  label: 'Mobile',
                  keyboardType: TextInputType.phone,
                  prefixIcon: Icons.phone_outlined,
                ),
                const SizedBox(height: AppSpacing.md12),

                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppTextField(
                        controller: _gst,
                        label: 'GST Number',
                      ),
                    ),
                    const SizedBox(width: AppSpacing.md12),
                    Expanded(
                      child: AppTextField(
                        controller: _pan,
                        label: 'PAN Number',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md12),

                AppTextField(
                  controller: _financialYear,
                  label: 'Financial Year',
                  hint: 'e.g. 2025-2026',
                  prefixIcon: Icons.event_outlined,
                ),
                const SizedBox(height: AppSpacing.md12),

                AppTextField(
                  controller: _address,
                  label: 'Address',
                  prefixIcon: Icons.location_on_outlined,
                  maxLines: 3,
                ),
                const SizedBox(height: AppSpacing.xl24),

                AppButton(
                  label: 'Save Settings',
                  icon: Icons.save_outlined,
                  loading: _busy,
                  onPressed: _save,
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
