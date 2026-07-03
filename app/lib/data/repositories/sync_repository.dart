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

  // ── Manual actions (mirror the web Sync Dashboard buttons) ──────────
  /// Retry failed records. Default 'push' re-queues failed rows TO Tally;
  /// 'pull' re-imports FROM Tally. [module] scopes to one module (else all).
  Future<dynamic> retry({String? module, String? direction}) => _api.post('/sync/retry', body: {
        if (module != null) 'module': module,
        if (direction != null) 'direction': direction,
      });

  /// Pull everything from Tally now ("Sync Now").
  Future<dynamic> pull() => _api.post('/sync/pull', body: const {});

  /// Flip the per-license auto-sync toggles (master + per-direction).
  Future<dynamic> setDirection({bool? syncEnabled, bool? pushEnabled, bool? pullEnabled}) =>
      _api.patch('/account/sync-direction', body: {
        if (syncEnabled != null) 'sync_enabled': syncEnabled,
        if (pushEnabled != null) 'push_enabled': pushEnabled,
        if (pullEnabled != null) 'pull_enabled': pullEnabled,
      });

  /// Flip the per-license agent auto-update toggle.
  Future<dynamic> setAutoUpdate(bool enabled) =>
      _api.patch('/account/agent/auto-update', body: {'enabled': enabled});

  /// Force the desktop agent to self-update now ("Update" button).
  Future<dynamic> selfUpdate() => _api.post('/account/agent/self-update', body: const {});
}

final syncRepositoryProvider = Provider<SyncRepository>((ref) {
  return SyncRepository(ref.watch(apiClientProvider));
});
