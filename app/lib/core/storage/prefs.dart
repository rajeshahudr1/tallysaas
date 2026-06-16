import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../constants.dart';

/// Wrapper around `SharedPreferences` for non-secret toggles. Exposed as
/// Riverpod providers so widgets can `ref.watch` them without juggling
/// async getters in build methods.
class AppPrefs {
  AppPrefs(this._p);
  final SharedPreferences _p;

  // ─── Theme ─────────────────────────────────────────────────
  /// Reads the persisted theme choice; absence → follow the system.
  ThemeMode getThemeMode() {
    final v = _p.getString(AppConfig.kThemeKey);
    if (v == 'light') return ThemeMode.light;
    if (v == 'dark')  return ThemeMode.dark;
    return ThemeMode.system;
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    final v = switch (mode) {
      ThemeMode.light  => 'light',
      ThemeMode.dark   => 'dark',
      ThemeMode.system => '',
    };
    if (v.isEmpty) {
      await _p.remove(AppConfig.kThemeKey);
    } else {
      await _p.setString(AppConfig.kThemeKey, v);
    }
  }
}

/// Holds the singleton `SharedPreferences`. Wired in `main()` after
/// `WidgetsFlutterBinding.ensureInitialized()` via a provider override so
/// the rest of the tree can read prefs synchronously. Throws if read before
/// the override is installed — surfaces wiring bugs immediately.
final sharedPreferencesProvider = Provider<SharedPreferences>((_) {
  throw UnimplementedError(
    'sharedPreferencesProvider was read before main() override',
  );
});

final appPrefsProvider = Provider<AppPrefs>((ref) {
  return AppPrefs(ref.watch(sharedPreferencesProvider));
});
