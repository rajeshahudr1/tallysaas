import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app/app.dart';
import 'core/storage/prefs.dart';

/// Entrypoint — bootstraps any async-only services (SharedPreferences in
/// particular) BEFORE the widget tree mounts. That way every screen can
/// `ref.watch(appPrefsProvider)` synchronously instead of juggling a
/// `FutureBuilder` everywhere.
///
/// The resolved `SharedPreferences` is fed in through a provider override so
/// `sharedPreferencesProvider` (which throws until overridden) resolves for
/// the rest of the tree.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();

  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
      ],
      child: const TallyApp(),
    ),
  );
}
