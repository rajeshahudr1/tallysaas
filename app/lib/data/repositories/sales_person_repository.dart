import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/sales_person.dart';

/// Sales-person master endpoints. Company rides the `X-Company-Id` header.
/// Mirrors the web BFF's sales-person routes.
class SalesPersonRepository {
  SalesPersonRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<SalesPerson>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.salesPersons, query: query);
    return PagedResult<SalesPerson>.fromData(data, SalesPerson.fromJson);
  }

  /// Fetch ONE sales person — drives View + Edit.
  Future<SalesPerson> get(int id) async {
    final data = await _api.get('${Endpoints.salesPersons}/$id');
    if (data is! Map) {
      throw StateError('Sales person response was not a JSON object.');
    }
    return SalesPerson.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.salesPersons, body: body);

  /// Update a sales person (`PUT /sales-persons/:id`).
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.salesPersons}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.salesPersons}/$id');

  // ── Login & assignment (mirror the web's edit tabs) ──────────────────────

  /// Current assignments for pre-fill: `{location_ids: [], customers: {locId:
  /// [custIds]}, user: {role_id,email,status} | null}`. (`GET …/assignments`.)
  Future<Map<String, dynamic>> getAssignments(int id) async {
    final data = await _api.get('${Endpoints.salesPersons}/$id/assignments');
    return data is Map ? data.cast<String, dynamic>() : <String, dynamic>{};
  }

  /// Set / update the optional login. Body: {email, password, role_id, status}.
  Future<dynamic> setLogin(int id, Map<String, dynamic> body) =>
      _api.post('${Endpoints.salesPersons}/$id/login', body: body);

  /// Replace the assigned locations. (`PUT …/locations`.)
  Future<dynamic> setLocations(int id, List<int> locationIds) =>
      _api.put('${Endpoints.salesPersons}/$id/locations', body: {'location_ids': locationIds});

  /// Replace the assigned customers for ONE location. (`PUT …/customers`.)
  Future<dynamic> setCustomers(int id, int locationId, List<int> customerIds) =>
      _api.put('${Endpoints.salesPersons}/$id/customers',
          body: {'location_id': locationId, 'customer_ids': customerIds});
}

final salesPersonRepositoryProvider = Provider<SalesPersonRepository>((ref) {
  return SalesPersonRepository(ref.watch(apiClientProvider));
});
