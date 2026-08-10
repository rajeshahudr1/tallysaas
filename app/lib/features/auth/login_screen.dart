import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/brand.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/auth_service.dart';
import '../../core/storage/prefs.dart';
import '../../core/utils/validators.dart';
import '../../shared/layouts/auth_shell.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Sign-in form — a 1:1 port of the WEB sign-in at its mobile breakpoint
/// (web/views/auth/login.ejs, `@media (max-width: 991.98px)`): a plain white
/// page, the full brand lock-up centred at the top, "Welcome back! 👋", the
/// two fields with their leading icons, a Remember me / Forgot password row,
/// then the gradient Sign in button. Nothing else — the desktop brand story
/// and the gradient blade are desktop-only there too.
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
  bool _remember = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // "Remember me" on the web prefills the address on the next visit; do the
    // same here. Read once — prefs are already loaded by main().
    final saved = ref.read(appPrefsProvider).getRememberedEmail();
    if (saved != null) {
      _emailCtl.text = saved;
      _remember = true;
    }
  }

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
      // Persist (or clear) the remembered address only after a SUCCESSFUL
      // sign-in, so a typo never becomes the prefill.
      await ref
          .read(appPrefsProvider)
          .setRememberedEmail(_remember ? _emailCtl.text.trim() : null);
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
    return AuthShell(
      child: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Brand lock-up — the same PNG the web card shows on mobile
            // (`.login-card-logo`), capped by WIDTH so the wide wordmark can
            // never blow up vertically.
            Center(
              child: Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xl24),
                child: Image.asset(
                  Brand.logoFullAsset,
                  width: 210,
                  fit: BoxFit.contain,
                ),
              ),
            ),

            const Text(
              'Welcome back! 👋',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 21,
                fontWeight: FontWeight.w700,
                color: AppColors.text1,
              ),
            ),
            const SizedBox(height: 5),
            const Text(
              'Sign in to your ${Brand.name} account',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: AppColors.text2),
            ),
            const SizedBox(height: AppSpacing.xl24),

            if (_error != null) ...[
              _ErrorBanner(_error!),
              const SizedBox(height: AppSpacing.md12),
            ],

            AppTextField(
              label: 'Email address',
              controller: _emailCtl,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              prefixIcon: Icons.mail_outline,
              validator: Validators.email,
              hint: 'Enter your email',
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
              hint: 'Enter your password',
              // Eye toggle sits inside the field, as on the web form.
              suffix: IconButton(
                onPressed:
                    _busy ? null : () => setState(() => _obscure = !_obscure),
                icon: Icon(
                  _obscure
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                  size: 20,
                  color: AppColors.text3,
                ),
                tooltip: _obscure ? 'Show password' : 'Hide password',
              ),
            ),

            // Remember me · Forgot password — one row, as on the web.
            const SizedBox(height: AppSpacing.sm8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                InkWell(
                  borderRadius: BorderRadius.circular(AppRadius.sm8),
                  onTap: _busy ? null : () => setState(() => _remember = !_remember),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 4, 6, 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 22,
                          height: 22,
                          child: Checkbox(
                            value: _remember,
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            activeColor: AppColors.primary,
                            onChanged: _busy
                                ? null
                                : (v) => setState(() => _remember = v ?? false),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.sm8),
                        const Text(
                          'Remember me',
                          style: TextStyle(fontSize: 12.5, color: AppColors.text2),
                        ),
                      ],
                    ),
                  ),
                ),
                GestureDetector(
                  onTap: _busy ? null : () => context.go('/forgot-password'),
                  child: const Text(
                    'Forgot password?',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.primary,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg16),

            AppButton(
              label: 'Sign in',
              icon: Icons.login,
              loading: _busy,
              onPressed: _submit,
            ),
          ],
        ),
      ),
    );
  }
}

/// Soft red inline banner carrying the friendly `ApiException.message` —
/// the web's `.login-err`.
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md12,
        vertical: 11,
      ),
      decoration: BoxDecoration(
        color: const Color(0xFFFEE2E2),
        border: Border.all(color: const Color(0xFFFECACA)),
        borderRadius: BorderRadius.circular(AppRadius.md12),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 18, color: Color(0xFFB91C1C)),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: Color(0xFFB91C1C), fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
