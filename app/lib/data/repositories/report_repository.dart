import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';

/// Read-only report endpoints (`/reports/*`). Every report is company-scoped
/// (the `X-Company-Id` header rides along automatically) and returns a bespoke
/// envelope — some are `{ summary, data, meta }` tables, some are summary
/// objects (gst-summary, profit-loss, balance-sheet), and the ledger is a
/// party statement. The shapes are heterogeneous enough that the repository
/// just hands back the raw decoded `data` (a `Map`) and the viewer layer reads
/// the fields it needs. See `ReportController.js` for the exact shapes.
///
///   • GET /reports/sales-register ?date_from ?date_to ?status ?customer_id
///   • GET /reports/day-book        ?date_from ?date_to
///   • GET /reports/outstanding     ?type=receivable|payable
///   • GET /reports/gst-summary     ?date_from ?date_to
///   • GET /reports/stock-summary
///   • GET /reports/ledger          ?party_type=customer|supplier &party_id
///   • GET /reports/trial-balance
///   • GET /reports/profit-loss
///   • GET /reports/balance-sheet
class ReportRepository {
  ReportRepository(this._api);
  final ApiClient _api;

  /// Generic fetch: GET [endpoint] with optional [query], returning the raw
  /// unwrapped `data` payload (a `Map<String, dynamic>` for every report).
  /// Throws `ApiException` on a non-200 envelope.
  Future<Map<String, dynamic>> fetch(
    String endpoint, {
    Map<String, dynamic>? query,
  }) async {
    final data = await _api.get(endpoint, query: query);
    if (data is Map) return data.cast<String, dynamic>();
    // Defensive: a bare list (no envelope) still becomes a usable map.
    return <String, dynamic>{'data': data};
  }
}

final reportRepositoryProvider = Provider<ReportRepository>((ref) {
  return ReportRepository(ref.watch(apiClientProvider));
});
