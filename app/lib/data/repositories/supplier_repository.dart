import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/supplier.dart';

/// Supplier master endpoints (Tally "sundry creditors"). The active company
/// rides the `X-Company-Id` header (ApiClient interceptor), so these methods
/// never pass a company id. Mirrors the web BFF's supplier routes.
///
///   • GET    /suppliers?page&per_page&search&status   → { data, meta }   [suppliers.view]
///   • GET    /suppliers/:id                            → { data }         [suppliers.view]
///   • POST   /suppliers                               (create)          [suppliers.create]
///   • PUT    /suppliers/:id                           (update)          [suppliers.edit]
///   • DELETE /suppliers/:id                           (soft delete)     [suppliers.delete]
class SupplierRepository {
  SupplierRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Supplier>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.suppliers, query: query);
    return PagedResult<Supplier>.fromData(data, Supplier.fromJson);
  }

  /// Fetch ONE supplier with every editable column — drives View + Edit.
  Future<Supplier> get(int id) async {
    final data = await _api.get('${Endpoints.suppliers}/$id');
    if (data is! Map) {
      throw StateError('Supplier response was not a JSON object.');
    }
    return Supplier.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.suppliers, body: body);

  /// Update a supplier (`PUT /suppliers/:id`). Same `body` shape as [create].
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.suppliers}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.suppliers}/$id');
}

final supplierRepositoryProvider = Provider<SupplierRepository>((ref) {
  return SupplierRepository(ref.watch(apiClientProvider));
});
