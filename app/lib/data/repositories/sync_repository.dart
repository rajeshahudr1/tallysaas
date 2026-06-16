import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/sync_log.dart';
import '../models/sync_summary.dart';

/// Read-only Tally-sync bookkeeping. The desktop Python agent does the actual
/// push/pull to Tally; the cloud just exposes status. Company rides the
/// `X-Company-Id` header (added by the interceptor — never passed here).
///
///   • GET /sync/summary             → { summary, stats, modules, recent }
///   • GET /sync/logs?page&per_page  → { data, meta }
class SyncRepository {
  SyncRepository(this._api);
  final ApiClient _api;

  /// Agent connectivity + headline stats + per-module breakdown + recent feed.
  Future<SyncSummary> summary() async {
    final data = await _api.get(Endpoints.syncSummary);
    final map = (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
    return SyncSummary.fromJson(map);
  }

  /// Paginated sync-log rows, newest first (server orders by id desc).
  Future<PagedResult<SyncLog>> logs({int page = 1, int perPage = 20}) async {
    final data = await _api.get(
      Endpoints.syncLogs,
      query: {'page': page, 'per_page': perPage},
    );
    return PagedResult<SyncLog>.fromData(data, SyncLog.fromJson);
  }
}

final syncRepositoryProvider = Provider<SyncRepository>((ref) {
  return SyncRepository(ref.watch(apiClientProvider));
});
