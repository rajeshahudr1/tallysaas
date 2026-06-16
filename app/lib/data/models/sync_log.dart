/// One row from `GET /sync/logs` (paginated `{ data, meta }`). The Node
/// controller (`SyncController.logs`) selects exactly:
///
///   module, record_type, record_id, direction, status, message,
///   created_at, synced_at
///
/// from `tally_sync_logs`. There is no `id` column in the projection, so the
/// list keys rows by index. pg returns numeric/bigint columns as strings, so
/// coercions are defensive (mirrors the helper pattern in `payment.dart`).
class SyncLog {
  const SyncLog({
    this.module,
    this.recordType,
    this.recordId,
    this.direction,
    this.status,
    this.message,
    this.createdAt,
    this.syncedAt,
  });

  final String? module; // Customers / Sales Invoices / Payments …
  final String? recordType; // entity label written by the agent
  final int? recordId;
  final String? direction; // push | pull
  final String? status; // synced | failed | pending* | sent*
  final String? message;
  final String? createdAt;
  final String? syncedAt;

  /// A short title for the row — `record_type` if present, else `module`,
  /// else a generic fallback so the card never renders blank.
  String get title => recordType ?? module ?? 'Sync record';

  factory SyncLog.fromJson(Map<String, dynamic> j) => SyncLog(
        module: _sn(j['module']),
        recordType: _sn(j['record_type']),
        recordId: _toInt(j['record_id']),
        direction: _sn(j['direction']),
        status: _sn(j['status']),
        message: _sn(j['message']),
        createdAt: _sn(j['created_at']),
        syncedAt: _sn(j['synced_at']),
      );

  static String? _sn(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  static int? _toInt(Object? v) {
    if (v == null) return null;
    if (v is num) return v.toInt();
    final s = v.toString().trim();
    return s.isEmpty ? null : int.tryParse(s);
  }
}
