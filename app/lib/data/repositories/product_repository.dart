import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/product.dart';

/// Product master endpoints (Tally stock items). The active company rides the
/// `X-Company-Id` header (ApiClient interceptor). Mirrors the web BFF's product
/// routes.
///
///   • GET    /products?page&per_page&search&status   → { data, meta }
///   • POST   /products                               (create)
///   • DELETE /products/:id                           (soft delete)
class ProductRepository {
  ProductRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Product>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.products, query: query);
    return PagedResult<Product>.fromData(data, Product.fromJson);
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.products, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.products}/$id');
}

final productRepositoryProvider = Provider<ProductRepository>((ref) {
  return ProductRepository(ref.watch(apiClientProvider));
});
