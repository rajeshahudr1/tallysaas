import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/journal.dart';
import '../models/paged.dart';

/// Which voucher family this repository talks to. The API runs the SAME
/// JournalController under two paths — `/journals` for the Dr/Cr adjustment
/// vouchers and `/contra` for cash⇄bank transfers, which it forces to
/// `vch_type: 'Contra'` at the route level — each with its own permission slug.
enum JournalScope {
  journals,
  contra;

  String get path => this == contra ? '/contra' : '/journals';

  /// Permission slug + module-info key.
  String get module => this == contra ? 'contra' : 'journals';

  String get title => this == contra ? 'Contra' : 'Journals';
  String get singular => this == contra ? 'Contra' : 'Journal';
}

/// Journal voucher endpoints. Company rides the `X-Company-Id` header.
///
///   • GET    /journals?page&per_page&search&status   → { data, meta }
///   • POST   /journals                               (create; auto JV-NNNN)
///   • DELETE /journals/:id                           (soft delete)
class JournalRepository {
  JournalRepository(this._api, [this.scope = JournalScope.journals]);
  final ApiClient _api;
  final JournalScope scope;

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
    final data = await _api.get(scope.path, query: query);
    return PagedResult<Journal>.fromData(data, Journal.fromJson);
  }

  /// Fetch ONE journal (with its Dr/Cr entries) — drives the View screen.
  Future<Journal> get(int id) async {
    final data = await _api.get('${scope.path}/$id');
    return Journal.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(scope.path, body: body);

  Future<void> delete(int id) => _api.delete('${scope.path}/$id');
}

/// One repository per scope — `ref.watch(journalRepositoryProvider(scope))`.
final journalRepositoryProvider =
    Provider.family<JournalRepository, JournalScope>((ref, scope) {
  return JournalRepository(ref.watch(apiClientProvider), scope);
});
