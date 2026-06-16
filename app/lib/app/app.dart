import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router.dart';
import 'theme.dart';

/// Root of the widget tree. Wires:
///   • MaterialApp.router(...)       — declarative routing via GoRouter
///   • theme + darkTheme + themeMode — brand light/dark from `AppTheme`
///
/// Everything below this consumes Riverpod providers; `main()` already
/// wrapped the tree in `ProviderScope`. Theme mode is pinned to light for
/// Phase 1 (`dark()` is supplied so a later phase can flip it for free).
class TallyApp extends ConsumerWidget {
  const TallyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'Tally Cloud Sync',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.light,
      routerConfig: router,
    );
  }
}
