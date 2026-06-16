import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/supplier.dart';

/// Supplier master endpoints (Tally "sundry creditors"). The active company
/// rides the `X-Company-Id` header (ApiClient interceptor), so these methods
/// never pass a company id. Mirrors the web BFF's supplier routes.
///
///   • GET    /suppliers?page&per_page&search&status   → { data, meta }
///   • POST   /suppliers                               (create)
///   • DELETE /suppliers/:id                           (soft delete)
class SupplierRepository {
  SupplierRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Supplier>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.suppliers, query: query);
    return PagedResult<Supplier>.fromData(data, Supplier.fromJson);
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.suppliers, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.suppliers}/$id');
}

final supplierRepositoryProvider = Provider<SupplierRepository>((ref) {
  return SupplierRepository(ref.watch(apiClientProvider));
});
