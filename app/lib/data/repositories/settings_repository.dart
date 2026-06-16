import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/settings.dart';

/// Company-settings endpoint. The active company rides the `X-Company-Id`
/// header (set by the ApiClient interceptor), so neither method passes a
/// company id — the server scopes by it.
///
///   • GET /settings → { company:{...}, settings:{...} }
///   • PUT /settings   body may carry company:{...} (patch the editable
///                     profile columns) and/or settings:{key:value,...}.
///                     Returns { updated: true }.
class SettingsRepository {
  SettingsRepository(this._api);
  final ApiClient _api;

  /// Loads the company profile + flat settings bag into a typed [Settings].
  Future<Settings> get() async {
    final data = await _api.get(Endpoints.settings);
    return Settings.fromJson((data as Map).cast<String, dynamic>());
  }

  /// Saves the changed values. `body` is `{ company:{...}, settings:{...} }`;
  /// the server only patches the editable company columns it recognises.
  Future<dynamic> update(Map<String, dynamic> body) =>
      _api.put(Endpoints.settings, body: body);
}

final settingsRepositoryProvider = Provider<SettingsRepository>((ref) {
  return SettingsRepository(ref.watch(apiClientProvider));
});

/// Read-only load of the current settings. The screen seeds its editable
/// controllers from this once, then PUTs through the repository on save.
final settingsProvider = FutureProvider.autoDispose<Settings>((ref) {
  return ref.watch(settingsRepositoryProvider).get();
});
