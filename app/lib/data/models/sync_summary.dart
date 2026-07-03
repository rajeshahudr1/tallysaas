/// The unwrapped `data` from `GET /sync/summary`. The Node controller
/// (`SyncController.summary`) returns four blocks:
///
///   { summary, stats, modules, recent }
///
///   • summary — agent / license connectivity:
///       { connected, status, agent_version, last_seen_at, company }
///   • stats   — headline counts: { total_synced, pending, failed }
///   • modules — per-module breakdown rows:
///       { module, total, synced, pending, failed, last_sync }
///   • recent  — last 6 sync-log rows:
///       { module, record_type, record_id, status, created_at }
///
/// pg hands numeric/bigint columns back as strings, so every coercion is
/// defensive (mirrors the helper pattern in `payment.dart`).
class SyncSummary {
  const SyncSummary({
    required this.connected,
    this.status,
    this.agentVersion,
    this.lastSeenAt,
    this.company,
    this.lastSyncAt,
    this.autoUpdate = false,
    this.syncEnabled = false,
    this.pushEnabled = false,
    this.pullEnabled = false,
    this.updateAvailable = false,
    required this.totalSynced,
    required this.pending,
    required this.failed,
    required this.modules,
    required this.recent,
  });

  // ── summary block ──────────────────────────────────────────
  final bool connected;
  final String? status; // license status (active / blocked / unknown …)
  final String? agentVersion;
  final String? lastSeenAt;
  final String? company;
  final String? lastSyncAt;

  // ── sync toggles (agent behaviour) ─────────────────────────
  final bool autoUpdate;
  final bool syncEnabled;
  final bool pushEnabled;
  final bool pullEnabled;
  final bool updateAvailable;

  // ── stats block ────────────────────────────────────────────
  final int totalSynced;
  final int pending;
  final int failed;

  // ── per-module breakdown ───────────────────────────────────
  final List<SyncModule> modules;

  // ── recent activity feed ───────────────────────────────────
  final List<SyncRecent> recent;

  /// A human-friendly connection label, used to colour the agent StatusPill.
  /// `connected` true → 'Synced' (green via statusColor); otherwise the raw
  /// license status, falling back to 'Inactive' (red).
  String get connectionLabel {
    if (connected) return 'Synced';
    final s = status;
    if (s != null && s.isNotEmpty && s.toLowerCase() != 'unknown') return s;
    return 'Inactive';
  }

  factory SyncSummary.fromJson(Map<String, dynamic> j) {
    final summary = _map(j['summary']);
    final stats = _map(j['stats']);

    final moduleRows = (j['modules'] is List) ? j['modules'] as List : const [];
    final recentRows = (j['recent'] is List) ? j['recent'] as List : const [];

    return SyncSummary(
      connected: _toBool(summary['connected']),
      status: _sn(summary['status']),
      agentVersion: _sn(summary['agent_version']),
      lastSeenAt: _sn(summary['last_seen_at']),
      company: _sn(summary['company']),
      lastSyncAt: _sn(summary['last_sync_at']),
      autoUpdate: _toBool(summary['auto_update']),
      syncEnabled: _toBool(summary['sync_enabled']),
      pushEnabled: _toBool(summary['push_enabled']),
      pullEnabled: _toBool(summary['pull_enabled']),
      updateAvailable: _toBool(summary['update_available']),
      totalSynced: _toInt(stats['total_synced']) ?? 0,
      pending: _toInt(stats['pending']) ?? 0,
      failed: _toInt(stats['failed']) ?? 0,
      modules: moduleRows
          .whereType<Map>()
          .map((m) => SyncModule.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
      recent: recentRows
          .whereType<Map>()
          .map((m) => SyncRecent.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
    );
  }

  static Map<String, dynamic> _map(Object? v) =>
      (v is Map) ? v.cast<String, dynamic>() : <String, dynamic>{};

  static bool _toBool(Object? v) {
    if (v == null) return false;
    if (v is bool) return v;
    if (v is num) return v != 0;
    final s = v.toString().trim().toLowerCase();
    return s == 'true' || s == 't' || s == '1';
  }

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

/// One row of the `modules` array — a per-module sync tally.
class SyncModule {
  const SyncModule({
    required this.key,
    required this.module,
    required this.total,
    required this.synced,
    required this.pending,
    required this.failed,
    this.lastSync,
  });

  final String key;     // action key (e.g. "customers") — drives From/To Tally
  final String module;  // display label (e.g. "Customers")
  final int total;
  final int synced;
  final int pending;
  final int failed;
  final String? lastSync;

  /// Synced fraction 0..1 (for the progress bar).
  double get progress => total > 0 ? (synced / total).clamp(0.0, 1.0) : 0.0;

  factory SyncModule.fromJson(Map<String, dynamic> j) => SyncModule(
        key: _s(j['key']),
        module: _s(j['module']),
        total: _toInt(j['total']) ?? 0,
        synced: _toInt(j['synced']) ?? 0,
        pending: _toInt(j['pending']) ?? 0,
        failed: _toInt(j['failed']) ?? 0,
        lastSync: _sn(j['last_sync']),
      );

  static String _s(Object? v) => v == null ? '' : v.toString();
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

/// One row of the `recent` activity feed. This is a *trimmed* sync-log row
/// (no direction/message/synced_at) — the controller only selects
/// `module, record_type, record_id, status, created_at`.
class SyncRecent {
  const SyncRecent({
    this.module,
    this.message,
    this.recordType,
    this.recordId,
    this.status,
    this.createdAt,
  });

  final String? module;
  final String? message;   // friendly record name (e.g. "TestDebtorX"), when present
  final String? recordType;
  final int? recordId;
  final String? status;
  final String? createdAt;

  /// Best label for the row: the message/name if the API sends one, else
  /// "<record_type> #<record_id>".
  String get label {
    if (message != null && message!.isNotEmpty) return message!;
    final parts = [if (recordType != null) recordType!, if (recordId != null) '#$recordId'];
    return parts.isEmpty ? '—' : parts.join(' ');
  }

  factory SyncRecent.fromJson(Map<String, dynamic> j) => SyncRecent(
        module: _sn(j['module']),
        message: _sn(j['message']),
        recordType: _sn(j['record_type']),
        recordId: _toInt(j['record_id']),
        status: _sn(j['status']),
        createdAt: _sn(j['created_at']),
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
