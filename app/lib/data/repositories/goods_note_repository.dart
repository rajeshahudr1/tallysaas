import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/goods_note.dart';
import '../models/paged.dart';

/// Delivery / receipt note endpoints. ONE repository serves both — the two APIs
/// are separate controllers with parallel shapes, and [kind] supplies the path
/// and the per-kind query keys.
///
///   • GET    /<kind>?page&per_page&search&date_from&date_to&<kind>_status[&mine]
///   • GET    /<kind>/:id            → header + items
///   • POST   /<kind>                (create; auto note_no when blank)
///   • PUT    /<kind>/:id            (edit a DRAFT)
///   • POST   /<kind>/:id/convert    (turn the note into its invoice)
///   • DELETE /<kind>/:id            (soft delete)
class GoodsNoteRepository {
  GoodsNoteRepository(this._api, this.kind);
  final ApiClient _api;
  final GoodsNoteKind kind;

  Future<PagedResult<GoodsNote>> list({
    int page = 1,
    int perPage = 10,
    String? search,
    String? noteStatus,
    String? dateFrom,
    String? dateTo,
    bool mine = false,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (noteStatus != null && noteStatus.isNotEmpty) {
      query[kind.statusQueryKey] = noteStatus;
    }
    if (dateFrom != null && dateFrom.isNotEmpty) query['date_from'] = dateFrom;
    if (dateTo != null && dateTo.isNotEmpty) query['date_to'] = dateTo;
    // Only delivery notes accept ?mine=1 (the salesman scope).
    if (mine && kind.isDelivery) query['mine'] = '1';

    final data = await _api.get(kind.path, query: query);
    return PagedResult<GoodsNote>.fromData(
      data,
      (row) => GoodsNote.fromJson(row, kind),
    );
  }

  Future<GoodsNote> get(int id) async {
    final data = await _api.get('${kind.path}/$id');
    return GoodsNote.fromJson((data as Map).cast<String, dynamic>(), kind);
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(kind.path, body: body);

  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${kind.path}/$id', body: body);

  Future<dynamic> convert(int id) => _api.post('${kind.path}/$id/convert');

  Future<void> delete(int id) => _api.delete('${kind.path}/$id');
}

/// One repository per kind — `ref.watch(goodsNoteRepositoryProvider(kind))`.
final goodsNoteRepositoryProvider =
    Provider.family<GoodsNoteRepository, GoodsNoteKind>((ref, kind) {
  return GoodsNoteRepository(ref.watch(apiClientProvider), kind);
});
