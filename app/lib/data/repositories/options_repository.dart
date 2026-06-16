import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';

/// Fetches `{id, name}` option lists for FK dropdowns (Location, Sales Person,
/// Customer Group, Category, …) straight from the API — NOTHING is hardcoded,
/// so a change on the server reflects in both web and app. Mirrors the web
/// BFF's `fetchOptions(basePath)` (per_page=100 = the list validators' cap).
class OptionsRepository {
  OptionsRepository(this._api);
  final ApiClient _api;

  /// GET `<basePath>?per_page=100` → `[OptionItem]`. e.g. basePath '/locations',
  /// '/sales-persons', '/customer-groups', '/categories', '/suppliers',
  /// '/customers', '/products', '/roles'.
  Future<List<OptionItem>> options(String basePath) async {
    final data = await _api.get(basePath, query: {'per_page': 100});
    final paged = PagedResult<OptionItem>.fromData(data, OptionItem.fromJson);
    return paged.items;
  }
}

final optionsRepositoryProvider = Provider<OptionsRepository>((ref) {
  return OptionsRepository(ref.watch(apiClientProvider));
});

/// Cached option list for an endpoint, keyed by basePath. Kept alive briefly so
/// re-opening a form doesn't refetch every dropdown. Forms do:
///   final locs = ref.watch(optionsProvider('/locations'));
final optionsProvider = FutureProvider.autoDispose
    .family<List<OptionItem>, String>((ref, basePath) async {
  final link = ref.keepAlive();
  Future.delayed(const Duration(seconds: 120), link.close);
  return ref.read(optionsRepositoryProvider).options(basePath);
});
