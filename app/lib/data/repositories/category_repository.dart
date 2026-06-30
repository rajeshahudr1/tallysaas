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
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.categories, query: query);
    return PagedResult<Category>.fromData(data, Category.fromJson);
  }

  /// Fetch ONE category (with parent_id) — drives View + Edit.
  Future<Category> get(int id) async {
    final data = await _api.get('${Endpoints.categories}/$id');
    if (data is! Map) {
      throw StateError('Category response was not a JSON object.');
    }
    return Category.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.categories, body: body);

  /// Update a category (`PUT /categories/:id`).
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.categories}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.categories}/$id');
}

final categoryRepositoryProvider = Provider<CategoryRepository>((ref) {
  return CategoryRepository(ref.watch(apiClientProvider));
});
