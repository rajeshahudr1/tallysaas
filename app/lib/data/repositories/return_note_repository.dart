import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/return_note.dart';

/// Credit / debit note endpoints. ONE repository serves both because the API
/// runs one controller under two paths with two permission slugs — the [kind]
/// decides which path each call hits.
///
///   • GET    /<kind>-notes?page&per_page&search&date_from&date_to
///   • GET    /<kind>-notes/:id           → header + items
///   • POST   /<kind>-notes               (create; auto CN-/DBN- number)
///   • PUT    /<kind>-notes/:id           (edit a DRAFT)
///   • DELETE /<kind>-notes/:id           (soft delete)
class ReturnNoteRepository {
  ReturnNoteRepository(this._api, this.kind);
  final ApiClient _api;
  final ReturnNoteKind kind;

  Future<PagedResult<ReturnNote>> list({
    int page = 1,
    int perPage = 10,
    String? search,
    String? dateFrom,
    String? dateTo,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (dateFrom != null && dateFrom.isNotEmpty) query['date_from'] = dateFrom;
    if (dateTo != null && dateTo.isNotEmpty) query['date_to'] = dateTo;
    final data = await _api.get(kind.path, query: query);
    return PagedResult<ReturnNote>.fromData(data, ReturnNote.fromJson);
  }

  Future<ReturnNote> get(int id) async {
    final data = await _api.get('${kind.path}/$id');
    return ReturnNote.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(kind.path, body: body);

  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${kind.path}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${kind.path}/$id');
}

/// One repository per kind — `ref.watch(returnNoteRepositoryProvider(kind))`.
final returnNoteRepositoryProvider =
    Provider.family<ReturnNoteRepository, ReturnNoteKind>((ref, kind) {
  return ReturnNoteRepository(ref.watch(apiClientProvider), kind);
});
