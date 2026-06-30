import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/journal.dart';
import '../models/paged.dart';

/// Journal voucher endpoints. Company rides the `X-Company-Id` header.
///
///   • GET    /journals?page&per_page&search&status   → { data, meta }
///   • POST   /journals                               (create; auto JV-NNNN)
///   • DELETE /journals/:id                           (soft delete)
class JournalRepository {
  JournalRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Journal>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
    String? dateFrom,
    String? dateTo,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (dateFrom != null) query['date_from'] = dateFrom;
    if (dateTo != null) query['date_to'] = dateTo;
    final data = await _api.get(Endpoints.journals, query: query);
    return PagedResult<Journal>.fromData(data, Journal.fromJson);
  }

  /// Fetch ONE journal (with its Dr/Cr entries) — drives the View screen.
  Future<Journal> get(int id) async {
    final data = await _api.get('${Endpoints.journals}/$id');
    return Journal.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.journals, body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.journals}/$id');
}

final journalRepositoryProvider = Provider<JournalRepository>((ref) {
  return JournalRepository(ref.watch(apiClientProvider));
});
