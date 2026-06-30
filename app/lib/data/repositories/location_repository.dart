import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/location.dart';
import '../models/paged.dart';

/// Location master endpoints (Tally godowns / branches). Company rides the
/// `X-Company-Id` header. Mirrors the web BFF's location routes.
class LocationRepository {
  LocationRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Location>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.locations, query: query);
    return PagedResult<Location>.fromData(data, Location.fromJson);
  }

  /// Fetch ONE location with every editable column — drives View + Edit.
  Future<Location> get(int id) async {
    final data = await _api.get('${Endpoints.locations}/$id');
    if (data is! Map) {
      throw StateError('Location response was not a JSON object.');
    }
    return Location.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.locations, body: body);

  /// Update a location (`PUT /locations/:id`).
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.locations}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.locations}/$id');
}

final locationRepositoryProvider = Provider<LocationRepository>((ref) {
  return LocationRepository(ref.watch(apiClientProvider));
});
