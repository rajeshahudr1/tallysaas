import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/auth_service.dart';
import '../../core/utils/validators.dart';
import '../../shared/layouts/auth_shell.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Sign-in form. Hosts:
///   • email + password fields with the shared validators
///   • an inline error banner + SnackBar for failed attempts
///   • a demo-credentials hint to speed up first-run testing
///
/// All async work goes through `authServiceProvider.login`; the router
/// detects the resulting `SessionSignedIn` and bounces to /dashboard, so
/// there is no manual navigation here.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailCtl = TextEditingController();
  final _pwCtl = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _emailCtl.dispose();
    _pwCtl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authServiceProvider).login(
            _emailCtl.text.trim(),
            _pwCtl.text,
          );
      // Router redirect kicks in via sessionProvider — no manual nav.
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e, stack) {
      // Surface the actual error so field-mismatch / wiring bugs are
      // debuggable without shipping a verbose log build.
      debugPrint('Login non-API error: $e\n$stack');
      _showError('Login failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Reflect the failure both inline (persistent) and as a SnackBar
  /// (transient) so the user can't miss it whichever they glance at.
  void _showError(String message) {
    if (!mounted) return;
    setState(() => _error = message);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AuthShell(
      child: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Welcome back', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs4),
            Text(
              'Sign in to your TallySaaS account to continue.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.xl24),

            if (_error != null) ...[
              _ErrorBanner(_error!),
              const SizedBox(height: AppSpacing.md12),
            ],

            AppTextField(
              label: 'Email',
              controller: _emailCtl,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              prefixIcon: Icons.mail_outline,
              validator: Validators.email,
              hint: 'you@company.com',
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              label: 'Password',
              controller: _pwCtl,
              obscure: _obscure,
              textInputAction: TextInputAction.done,
              prefixIcon: Icons.lock_outline,
              validator: (v) => Validators.minLen(v, 4, 'Password'),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: AppSpacing.sm8),

            // Quick toggle for the masked password field.
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: _busy
                    ? null
                    : () => setState(() => _obscure = !_obscure),
                icon: Icon(
                  _obscure ? Icons.visibility : Icons.visibility_off,
                  size: 18,
                ),
                label: Text(_obscure ? 'Show password' : 'Hide password'),
              ),
            ),

            const SizedBox(height: AppSpacing.md12),
            AppButton(
              label: 'Sign in',
              loading: _busy,
              onPressed: _submit,
            ),

            const SizedBox(height: AppSpacing.lg16),
            // Demo hint — handy while the API is still being seeded. Not a
            // hardcoded credential the app uses; purely an on-screen note.
            Text(
              'Demo: admin@tallysaas.test',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: AppColors.text3,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Soft red inline banner carrying the friendly `ApiException.message`.
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md12,
        vertical: AppSpacing.sm8,
      ),
      decoration: BoxDecoration(
        color: AppColors.danger.withOpacity(0.12),
        border: Border.all(color: AppColors.danger.withOpacity(0.35)),
        borderRadius: BorderRadius.circular(AppRadius.sm8),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 18, color: AppColors.danger),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: AppColors.danger, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
