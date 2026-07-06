import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/brand.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../shared/layouts/auth_shell.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Public forgot-password flow (one screen, two steps):
///   1. enter email   → POST /auth/forgot-password (emails a 6-digit code)
///   2. enter code +   → POST /auth/reset-password  → back to /login
///      new password
///
/// Mirrors the web sign-in chrome (brand lockup on the gradient card) and uses
/// the same shared field/button widgets as LoginScreen.
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _emailKey = GlobalKey<FormState>();
  final _resetKey = GlobalKey<FormState>();
  final _emailCtl = TextEditingController();
  final _codeCtl = TextEditingController();
  final _pwCtl = TextEditingController();

  bool _obscure = true;
  bool _busy = false;
  bool _codeSent = false;
  String? _error;

  @override
  void dispose() {
    _emailCtl.dispose();
    _codeCtl.dispose();
    _pwCtl.dispose();
    super.dispose();
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _sendCode() async {
    if (_busy) return;
    if (!(_emailKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(
        '/auth/forgot-password',
        body: {'email': _emailCtl.text.trim()},
      );
      if (!mounted) return;
      setState(() => _codeSent = true);
      _snack('If that email is registered, a 6-digit code has been sent.');
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resetPassword() async {
    if (_busy) return;
    if (!(_resetKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(
        '/auth/reset-password',
        body: {
          'email': _emailCtl.text.trim(),
          'code': _codeCtl.text.trim(),
          'password': _pwCtl.text,
        },
      );
      if (!mounted) return;
      _snack('Password reset. Please sign in.');
      context.go('/login');
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AuthShell(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Brand lockup — same as the sign-in screen.
          Row(
            children: [
              SvgPicture.asset(Brand.logoAsset, width: 44, height: 44),
              const SizedBox(width: AppSpacing.md12),
              const Text(
                Brand.name,
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.text1),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xl24),
          Text(_codeSent ? 'Enter code' : 'Forgot password', style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.xs4),
          Text(
            _codeSent
                ? 'Enter the 6-digit code we emailed and choose a new password.'
                : "Enter your account email and we'll send you a reset code.",
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.xl24),

          if (_error != null) ...[
            _ErrorBanner(_error!),
            const SizedBox(height: AppSpacing.md12),
          ],

          if (!_codeSent)
            Form(
              key: _emailKey,
              autovalidateMode: AutovalidateMode.onUserInteraction,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppTextField(
                    label: 'Email',
                    controller: _emailCtl,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.done,
                    prefixIcon: Icons.mail_outline,
                    validator: Validators.email,
                    hint: 'you@company.com',
                    onSubmitted: (_) => _sendCode(),
                  ),
                  const SizedBox(height: AppSpacing.lg16),
                  AppButton(label: 'Send code', loading: _busy, onPressed: _sendCode),
                ],
              ),
            )
          else
            Form(
              key: _resetKey,
              autovalidateMode: AutovalidateMode.onUserInteraction,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppTextField(
                    label: '6-digit code',
                    controller: _codeCtl,
                    keyboardType: TextInputType.number,
                    textInputAction: TextInputAction.next,
                    prefixIcon: Icons.pin_outlined,
                    validator: (v) => (v == null || v.trim().length != 6) ? 'Enter the 6-digit code.' : null,
                  ),
                  const SizedBox(height: AppSpacing.md12),
                  AppTextField(
                    label: 'New password',
                    controller: _pwCtl,
                    obscure: _obscure,
                    textInputAction: TextInputAction.done,
                    prefixIcon: Icons.lock_outline,
                    validator: (v) => Validators.minLen(v, 6, 'Password'),
                    onSubmitted: (_) => _resetPassword(),
                  ),
                  const SizedBox(height: AppSpacing.sm8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: _busy ? null : () => setState(() => _obscure = !_obscure),
                      icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off, size: 18),
                      label: Text(_obscure ? 'Show password' : 'Hide password'),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.md12),
                  AppButton(label: 'Reset password', loading: _busy, onPressed: _resetPassword),
                  const SizedBox(height: AppSpacing.sm8),
                  TextButton(
                    onPressed: _busy ? null : () => setState(() {
                          _codeSent = false;
                          _error = null;
                        }),
                    child: const Text('Use a different email'),
                  ),
                ],
              ),
            ),

          const SizedBox(height: AppSpacing.sm8),
          TextButton(
            onPressed: _busy ? null : () => context.go('/login'),
            child: const Text('Back to sign in'),
          ),
        ],
      ),
    );
  }
}

/// Soft red inline banner (same look as the sign-in screen's).
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md12, vertical: AppSpacing.sm8),
      decoration: BoxDecoration(
        color: AppColors.danger.withOpacity(0.12),
        border: Border.all(color: AppColors.danger.withOpacity(0.35)),
        borderRadius: BorderRadius.circular(AppRadius.sm8),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 18, color: AppColors.danger),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(child: Text(message, style: const TextStyle(color: AppColors.danger, fontSize: 13))),
        ],
      ),
    );
  }
}
