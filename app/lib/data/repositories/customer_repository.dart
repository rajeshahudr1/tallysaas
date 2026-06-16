import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/customer.dart';
import '../models/paged.dart';

/// Customer master endpoints. The active company rides the `X-Company-Id`
/// header (set by the ApiClient interceptor), so these methods never pass a
/// company id — the server scopes by it. Mirrors the web BFF's customer routes.
///
///   • GET    /customers?page&per_page&search&status   → { data, meta }
///   • POST   /customers                               (create)
///   • DELETE /customers/:id                           (soft delete)
class CustomerRepository {
  CustomerRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Customer>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.customers, query: query);
    return PagedResult<Customer>.fromData(data, Customer.fromJson);
  }

  /// Create a customer. `body` carries the known columns (name required; the
  /// rest optional FKs/fields). Returns the created row's `data`.
  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.customers, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.customers}/$id');
}

final customerRepositoryProvider = Provider<CustomerRepository>((ref) {
  return CustomerRepository(ref.watch(apiClientProvider));
});
