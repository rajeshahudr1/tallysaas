import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/models/payment_request.dart';
import '../../data/repositories/collect_payment_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import 'collect_payments_controller.dart';

/// Collect Payments settings — where the money lands. Until UPI is enabled with
/// a VPA, a payment link has nothing to pay into, so the list screen warns
/// about it and this is where it gets fixed.
class CollectPaymentSettingsScreen extends ConsumerStatefulWidget {
  const CollectPaymentSettingsScreen({super.key});

  @override
  ConsumerState<CollectPaymentSettingsScreen> createState() =>
      _CollectPaymentSettingsScreenState();
}

class _CollectPaymentSettingsScreenState
    extends ConsumerState<CollectPaymentSettingsScreen> {
  final _vpa = TextEditingController();
  final _payee = TextEditingController();
  bool _enabled = false;
  bool _hydrated = false;
  bool _busy = false;

  @override
  void dispose() {
    _vpa.dispose();
    _payee.dispose();
    super.dispose();
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_enabled && _vpa.text.trim().isEmpty) {
      _snack('A UPI ID is required to switch collection on.');
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(collectPaymentRepositoryProvider).saveSettings(
            CollectPaymentSettings(
              enabled: _enabled,
              upiVpa: _vpa.text.trim(),
              payeeName: _payee.text.trim(),
            ),
          );
      ref.invalidate(collectPaymentSettingsProvider);
      if (mounted) {
        _snack('Settings saved.');
        context.pop();
      }
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save the settings.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(collectPaymentSettingsProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Collect Payments Settings')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading settings…'),
        error: (e, _) => ErrorState(
          'Could not load the settings.',
          onRetry: () async => ref.invalidate(collectPaymentSettingsProvider),
        ),
        data: (s) {
          // Hydrate the controllers once; rebuilds must not clobber typing.
          if (!_hydrated) {
            _hydrated = true;
            _enabled = s.enabled;
            _vpa.text = s.upiVpa;
            _payee.text = s.payeeName;
          }
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.lg16),
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
                title: const Text('Accept UPI payments'),
                subtitle: const Text(
                    'Customers see a UPI QR and ID on the payment link page.'),
              ),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(
                controller: _vpa,
                label: 'UPI ID (VPA)',
                hint: 'yourbusiness@bank',
              ),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(
                controller: _payee,
                label: 'Payee name',
                hint: 'The name the customer will see while paying',
              ),
              const SizedBox(height: AppSpacing.lg16),
              Text(
                'Payments are collected directly into your UPI account — there '
                'is no gateway in between. A request is only marked paid when '
                'someone here confirms it, which also records the receipt.',
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
              ),
              const SizedBox(height: AppSpacing.lg16),
              AppButton(label: 'Save Settings', loading: _busy, onPressed: _save),
            ],
          );
        },
      ),
    );
  }
}
