import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/tally_ledger.dart';

/// A bucket list plus its header total — the API returns the total alongside
/// the rows, and the screen shows both.
class LedgerBucketPage {
  const LedgerBucketPage({
    required this.rows,
    required this.total,
    required this.page,
    required this.perPage,
    this.totalAmount,
    this.totalDc,
  });

  final List<LedgerRow> rows;
  final int total;
  final int page;
  final int perPage;

  /// The bucket's combined balance magnitude and side.
  final num? totalAmount;
  final String? totalDc;

  bool get hasMore => page * perPage < total;
}

/// Tally ledger endpoints — the Cash / Bank / Payables / Receivables screens
/// and one ledger's statement. Balances are period-derived by the API (replayed
/// from the synced double entry), so the date range genuinely changes them.
///
///   • GET /tally/ledgers?group=<bucket>&from&to&page&per_page&search
///   • GET /tally/ledgers/:name/statement?from&to&page&per_page&voucher_type
class TallyLedgerRepository {
  TallyLedgerRepository(this._api);
  final ApiClient _api;

  static const _base = '/tally/ledgers';

  Future<LedgerBucketPage> bucket(
    LedgerBucket bucket, {
    required String from,
    required String to,
    int page = 1,
    int perPage = 20,
    String? search,
  }) async {
    final query = <String, dynamic>{
      'group': bucket.group,
      'from': from,
      'to': to,
      'page': page,
      'per_page': perPage,
    };
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();

    final data = await _api.get(_base, query: query);
    final paged = PagedResult<LedgerRow>.fromData(data, LedgerRow.fromJson);
    final meta = (data is Map && data['meta'] is Map)
        ? (data['meta'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};

    return LedgerBucketPage(
      rows: paged.items,
      total: paged.total,
      page: paged.page,
      perPage: paged.perPage,
      totalAmount: _toNum(meta['total_amount']),
      totalDc: meta['total_dc']?.toString(),
    );
  }

  Future<LedgerStatement> statement(
    String name, {
    required String from,
    required String to,
    int page = 1,
    int perPage = 20,
    String? voucherType,
  }) async {
    final query = <String, dynamic>{
      'from': from,
      'to': to,
      'page': page,
      'per_page': perPage,
    };
    if (voucherType != null && voucherType.isNotEmpty) {
      query['voucher_type'] = voucherType;
    }
    final data = await _api.get(
      '$_base/${Uri.encodeComponent(name)}/statement',
      query: query,
    );
    return LedgerStatement.fromJson((data as Map).cast<String, dynamic>());
  }
}

num? _toNum(Object? v) {
  if (v == null) return null;
  if (v is num) return v;
  final s = v.toString().trim();
  return s.isEmpty ? null : num.tryParse(s);
}

final tallyLedgerRepositoryProvider = Provider<TallyLedgerRepository>((ref) {
  return TallyLedgerRepository(ref.watch(apiClientProvider));
});
