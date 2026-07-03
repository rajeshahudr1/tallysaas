import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/field_dashboard.dart';
import '../models/gps_config.dart';

/// SFA — field-sales endpoints for the logged-in salesman.
///   • GET /field/my-dashboard → assigned locations + tallies + approval counts
class FieldRepository {
  FieldRepository(this._api);
  final ApiClient _api;

  Future<FieldDashboard> myDashboard() async {
    final data = await _api.get('/field/my-dashboard');
    return FieldDashboard.fromJson((data as Map).cast<String, dynamic>());
  }

  // ── Phase 2 · GPS field tracking ─────────────────────────────────────
  Future<void> startDay({double? lat, double? lng}) => _api.post('/field/day/start',
      body: {if (lat != null) 'lat': lat, if (lng != null) 'lng': lng});

  Future<void> endDay({double? lat, double? lng}) => _api.post('/field/day/end',
      body: {if (lat != null) 'lat': lat, if (lng != null) 'lng': lng});

  /// Check in at a customer outlet. Returns the created visit row so the caller
  /// can read `checkin_within` / `checkin_distance_m` for the verified/far badge.
  Future<Map<String, dynamic>> checkin({
    required int customerId,
    double? lat,
    double? lng,
    String? note,
  }) async {
    final data = await _api.post('/field/visits/checkin', body: {
      'customer_id': customerId,
      if (lat != null) 'lat': lat,
      if (lng != null) 'lng': lng,
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
    return (data as Map).cast<String, dynamic>();
  }

  Future<void> checkout(int id, {double? lat, double? lng}) => _api.post(
      '/field/visits/$id/checkout',
      body: {if (lat != null) 'lat': lat, if (lng != null) 'lng': lng});

  // ── GPS tracking config + pings ──────────────────────────────────────
  Future<GpsConfig> gpsConfig() async {
    final data = await _api.get('/field/gps-config');
    return GpsConfig.fromJson((data as Map).cast<String, dynamic>());
  }

  /// Send a location ping. Returns the server result ({id} or {skipped}). The
  /// caller does the local change-detection before calling; the server also
  /// de-dupes as defence-in-depth.
  Future<Map<String, dynamic>> ping({
    required double lat,
    required double lng,
    required String source,
    double? accuracy,
    int? partVisitId,
  }) async {
    final data = await _api.post('/field/locations', body: {
      'lat': lat, 'lng': lng, 'source': source,
      if (accuracy != null) 'accuracy': accuracy,
      if (partVisitId != null) 'part_visit_id': partVisitId,
    });
    return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
  }

  /// Log a part-visit (picked beat/area + GPS).
  Future<void> partVisit({int? locationId, double? lat, double? lng, String? note}) =>
      _api.post('/field/part-visits', body: {
        if (locationId != null) 'location_id': locationId,
        if (lat != null) 'lat': lat,
        if (lng != null) 'lng': lng,
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      });

  Future<List<FieldVisit>> visits({String? date}) async {
    final data = await _api.get('/field/visits',
        query: {if (date != null && date.isNotEmpty) 'date': date});
    final rows = (data is Map && data['data'] is List)
        ? data['data'] as List
        : (data is List ? data : const []);
    return rows
        .whereType<Map>()
        .map((m) => FieldVisit.fromJson(m.cast<String, dynamic>()))
        .toList(growable: false);
  }
}

final fieldRepositoryProvider = Provider<FieldRepository>((ref) {
  return FieldRepository(ref.watch(apiClientProvider));
});
