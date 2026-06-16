import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';

/// Fetches the API's "config enumeration" lists (supplier groups, payment
/// terms, customer groups, GST rates, units, statuses …) from
/// `GET /config/options` — the SINGLE source of truth (api/Helpers/appOptions.js).
///
/// These feed <select> dropdowns that are NOT backed by a master table. The app
/// never hardcodes them: a change on the server reflects in both web and app.
/// Returns a `{ key: [strings] }` map; callers pick the list they need.
class ConfigRepository {
  ConfigRepository(this._api);
  final ApiClient _api;

  /// GET `/config/options` → `{ supplier_groups: [...], payment_terms: [...], … }`.
  /// Pass [keys] to fetch only some lists (server narrows the payload).
  Future<Map<String, List<String>>> options({List<String>? keys}) async {
    final query = (keys != null && keys.isNotEmpty)
        ? {'keys': keys.join(',')}
        : const <String, dynamic>{};
    final data = await _api.get(Endpoints.configOptions, query: query);
    final map = (data is Map) ? data.cast<String, dynamic>() : const <String, dynamic>{};
    final out = <String, List<String>>{};
    map.forEach((k, v) {
      if (v is List) {
        out[k] = v.map((e) => e?.toString() ?? '').where((s) => s.isNotEmpty).toList();
      }
    });
    return out;
  }
}

final configRepositoryProvider = Provider<ConfigRepository>((ref) {
  return ConfigRepository(ref.watch(apiClientProvider));
});

/// All config option lists, fetched once and cached for the session (these are
/// global enums that don't change between screens). Forms read a single list:
///   final terms = ref.watch(configListProvider('payment_terms'));
final configOptionsProvider =
    FutureProvider<Map<String, List<String>>>((ref) async {
  return ref.read(configRepositoryProvider).options();
});

/// One named config list (e.g. 'supplier_groups'), derived from
/// [configOptionsProvider]. Returns `[]` until loaded / if the key is absent.
final configListProvider =
    Provider.autoDispose.family<AsyncValue<List<String>>, String>((ref, key) {
  final async = ref.watch(configOptionsProvider);
  return async.whenData((map) => map[key] ?? const <String>[]);
});
