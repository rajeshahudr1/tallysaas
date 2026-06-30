import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/product.dart';

/// Product master endpoints (Tally stock items). The active company rides the
/// `X-Company-Id` header (ApiClient interceptor). Mirrors the web BFF's product
/// routes.
///
///   • GET    /products?page&per_page&search&status   → { data, meta }   [products.view]
///   • GET    /products/:id                            → { data }         [products.view]
///   • POST   /products                               (create)          [products.create]
///   • PUT    /products/:id                           (update)          [products.edit]
///   • DELETE /products/:id                           (soft delete)     [products.delete]
class ProductRepository {
  ProductRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Product>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.products, query: query);
    return PagedResult<Product>.fromData(data, Product.fromJson);
  }

  /// Fetch ONE product with every editable column — drives View + Edit.
  Future<Product> get(int id) async {
    final data = await _api.get('${Endpoints.products}/$id');
    if (data is! Map) {
      throw StateError('Product response was not a JSON object.');
    }
    return Product.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.products, body: body);

  /// Update a product (`PUT /products/:id`). Same `body` shape as [create].
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.products}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.products}/$id');
}

final productRepositoryProvider = Provider<ProductRepository>((ref) {
  return ProductRepository(ref.watch(apiClientProvider));
});
