import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/stock_voucher.dart';

/// Stock Journal endpoints — a goods-only voucher, so there is no convert step
/// and no edit (the API offers list / get / create / delete only).
///
///   • GET    /stock-journals?page&per_page&search&date_from&date_to
///   • GET    /stock-journals/:id      → header + items
///   • POST   /stock-journals
///   • DELETE /stock-journals/:id
class StockJournalRepository {
  StockJournalRepository(this._api);
  final ApiClient _api;

  static const _base = '/stock-journals';

  Future<PagedResult<StockJournal>> list({
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
    final data = await _api.get(_base, query: query);
    return PagedResult<StockJournal>.fromData(data, StockJournal.fromJson);
  }

  Future<StockJournal> get(int id) async {
    final data = await _api.get('$_base/$id');
    return StockJournal.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) => _api.post(_base, body: body);

  Future<void> delete(int id) => _api.delete('$_base/$id');
}

/// Physical Stock endpoints — a stock COUNT sheet. Sheets are addressed by
/// their voucher NUMBER (the API groups `stock_adjustments` rows by it), and
/// there is no edit or delete: a wrong count is corrected by a new sheet.
///
///   • GET  /physical-stock?page&per_page&date_from&date_to
///   • GET  /physical-stock/:voucher_no   → sheet + counted lines
///   • POST /physical-stock
class PhysicalStockRepository {
  PhysicalStockRepository(this._api);
  final ApiClient _api;

  static const _base = '/physical-stock';

  Future<PagedResult<PhysicalStockSheet>> list({
    int page = 1,
    int perPage = 10,
    String? dateFrom,
    String? dateTo,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (dateFrom != null && dateFrom.isNotEmpty) query['date_from'] = dateFrom;
    if (dateTo != null && dateTo.isNotEmpty) query['date_to'] = dateTo;
    final data = await _api.get(_base, query: query);
    return PagedResult<PhysicalStockSheet>.fromData(data, PhysicalStockSheet.fromJson);
  }

  Future<PhysicalStockSheet> get(String voucherNo) async {
    final data = await _api.get('$_base/${Uri.encodeComponent(voucherNo)}');
    return PhysicalStockSheet.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) => _api.post(_base, body: body);
}

final stockJournalRepositoryProvider = Provider<StockJournalRepository>((ref) {
  return StockJournalRepository(ref.watch(apiClientProvider));
});

final physicalStockRepositoryProvider = Provider<PhysicalStockRepository>((ref) {
  return PhysicalStockRepository(ref.watch(apiClientProvider));
});
