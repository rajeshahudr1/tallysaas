import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/category.dart';
import '../models/paged.dart';

/// Category master endpoints (Tally stock groups). Company rides the
/// `X-Company-Id` header. Mirrors the web BFF's category routes.
class CategoryRepository {
  CategoryRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Category>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.categories, query: query);
    return PagedResult<Category>.fromData(data, Category.fromJson);
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.categories, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.categories}/$id');
}

final categoryRepositoryProvider = Provider<CategoryRepository>((ref) {
  return CategoryRepository(ref.watch(apiClientProvider));
});
