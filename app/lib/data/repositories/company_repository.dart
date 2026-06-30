import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/company.dart';
import '../models/paged.dart';

/// Company master endpoints. The active company rides the `X-Company-Id` header.
/// Mirrors the web BFF's company routes.
///
///   • GET    /companies?page&per_page&search&status   → { data, meta }   [companies.view]
///   • GET    /companies/:id                            → { data }         [companies.view]
///   • POST   /companies                               (create)          [companies.create]
///   • PUT    /companies/:id                           (update)          [companies.edit]
///   • DELETE /companies/:id                           (soft delete)     [companies.delete]
class CompanyRepository {
  CompanyRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Company>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(Endpoints.companies, query: query);
    return PagedResult<Company>.fromData(data, Company.fromJson);
  }

  /// Fetch ONE company with every editable column — drives View + Edit.
  Future<Company> get(int id) async {
    final data = await _api.get('${Endpoints.companies}/$id');
    if (data is! Map) {
      throw StateError('Company response was not a JSON object.');
    }
    return Company.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.companies, body: body);

  /// Update a company (`PUT /companies/:id`).
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.companies}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.companies}/$id');
}

final companyRepositoryProvider = Provider<CompanyRepository>((ref) {
  return CompanyRepository(ref.watch(apiClientProvider));
});
