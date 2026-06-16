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
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.salesPersons, query: query);
    return PagedResult<SalesPerson>.fromData(data, SalesPerson.fromJson);
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.salesPersons, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.salesPersons}/$id');
}

final salesPersonRepositoryProvider = Provider<SalesPersonRepository>((ref) {
  return SalesPersonRepository(ref.watch(apiClientProvider));
});
