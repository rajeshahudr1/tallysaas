import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/auth/auth_service.dart';
import '../../shared/layouts/auth_shell.dart';
import '../../shared/widgets/loading_state.dart';

/// First-paint screen. Kicks off `AuthService.hydrate()` which reads the
/// cached JWT + user blob and flips `sessionProvider` to either SignedIn
/// (router → /dashboard) or Anonymous (router → /login).
///
/// Stateful so we only invoke hydrate once even though Riverpod may rebuild
/// this widget for unrelated reasons. Navigation is entirely the router's
/// job — this screen just triggers the session resolution and shows brand.
class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  bool _kicked = false;

  @override
  void initState() {
    super.initState();
    // Defer the actual call until after the first frame so the splash paints
    // instantly — the secure-storage read + JSON parse take a few ms which
    // would otherwise blank the screen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_kicked) return;
      _kicked = true;
      ref.read(authServiceProvider).hydrate();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AuthShell(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Brand wordmark — tinted onto the white auth card. We render the
          // app name as text rather than the logo asset so the splash works
          // even before the image is dropped into assets/images/.
          Text(
            'Tally Cloud Sync',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge?.copyWith(
              color: AppColors.primary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.xs4),
          Text(
            'Your books, in sync everywhere.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.xl24),
          const LoadingState(message: 'Loading…'),
        ],
      ),
    );
  }
}
