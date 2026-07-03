import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/models/gps_config.dart';
import '../../data/repositories/field_repository.dart';
import '../utils/location_helper.dart';

/// Foreground GPS tracker — drives the periodic "hourly" ping while the app is
/// open, plus on-demand captures for part-visit and product/invoice create.
///
/// Change-detection: the last-sent point is persisted (shared_preferences) and a
/// periodic ping is SKIPPED when the device moved less than [GpsConfig.minMoveM]
/// — the same standing location is never re-sent, saving API calls. Explicit
/// captures (part-visit / create) always send.
///
/// The config comes from GET /field/gps-config (super-admin, per-license): the
/// master switch, capture sources, interval, time window + min-move all gate it.
/// A true-background (app fully closed) foreground-service can be layered on top
/// later; this covers the common case where the app is open during work hours.
class GpsTracker {
  GpsTracker(this._repo);
  final FieldRepository _repo;

  Timer? _timer;
  GpsConfig _config = GpsConfig.disabled;
  double? _lastLat, _lastLng;
  bool _running = false;

  GpsConfig get config => _config;
  bool get isRunning => _running;

  /// Fetch the config and, if enabled + hourly, start the periodic loop.
  Future<void> start() async {
    stop();
    try {
      _config = await _repo.gpsConfig();
    } catch (_) {
      _config = GpsConfig.disabled;
    }
    if (!_config.enabled) return;
    _running = true;

    final prefs = await SharedPreferences.getInstance();
    _lastLat = prefs.getDouble('gps_last_lat');
    _lastLng = prefs.getDouble('gps_last_lng');

    if (_config.trackHourly) {
      final mins = _config.hourlyIntervalMin.clamp(1, 720);
      _timer = Timer.periodic(Duration(minutes: mins), (_) => _tick('hourly'));
      _tick('hourly'); // one immediate capture on start (within-window gated)
    }
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _running = false;
  }

  /// Capture on opening a product/invoice create/list page (if that source is on).
  Future<void> captureOnCreate() async {
    if (!_config.enabled || !_config.trackOnCreate) return;
    await _tick('create', force: true);
  }

  Future<void> _tick(String source, {bool force = false}) async {
    if (!_config.enabled) return;
    if (!_config.isWithinWindowNow) return;

    Position pos;
    try {
      pos = await LocationHelper.current();
    } catch (_) {
      return; // GPS off / permission denied — silently skip this tick
    }

    final moved = (_lastLat != null && _lastLng != null)
        ? Geolocator.distanceBetween(_lastLat!, _lastLng!, pos.latitude, pos.longitude)
        : null;
    // Change-detection: only the periodic 'hourly' source is de-duped.
    if (!force && source == 'hourly' && moved != null && moved < _config.minMoveM) {
      return;
    }

    try {
      await _repo.ping(lat: pos.latitude, lng: pos.longitude, source: source, accuracy: pos.accuracy);
      _lastLat = pos.latitude;
      _lastLng = pos.longitude;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble('gps_last_lat', pos.latitude);
      await prefs.setDouble('gps_last_lng', pos.longitude);
    } catch (_) {
      // transient — the next tick retries
    }
  }
}

final gpsTrackerProvider = Provider<GpsTracker>((ref) => GpsTracker(ref.watch(fieldRepositoryProvider)));
