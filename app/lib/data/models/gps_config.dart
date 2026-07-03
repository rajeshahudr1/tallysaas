/// The unwrapped `data` from `GET /field/gps-config` — the active (super-admin,
/// per-license) GPS tracking config for the logged-in salesman.
class GpsConfig {
  const GpsConfig({
    this.enabled = false,
    this.trackHourly = false,
    this.hourlyIntervalMin = 60,
    this.trackPartVisit = true,
    this.trackOnCreate = false,
    this.timeFrom = '07:00',
    this.timeTo = '20:00',
    this.minMoveM = 100,
    this.withinWindow = false,
    this.locations = const [],
  });

  final bool enabled;
  final bool trackHourly;
  final int hourlyIntervalMin;
  final bool trackPartVisit;
  final bool trackOnCreate;
  final String timeFrom;
  final String timeTo;
  final int minMoveM;
  final bool withinWindow;      // server-computed (at fetch time)
  final List<GpsBeat> locations; // assigned beats/areas for the part-visit picker

  static const disabled = GpsConfig();

  /// Live window check (the salesman keeps the app for hours, so re-evaluate
  /// locally rather than trusting the fetch-time [withinWindow]).
  bool get isWithinWindowNow {
    int mins(String s) {
      final p = s.split(':');
      final h = int.tryParse(p.isNotEmpty ? p[0] : '') ?? 0;
      final m = int.tryParse(p.length > 1 ? p[1] : '') ?? 0;
      return h * 60 + m;
    }
    final now = DateTime.now();
    final cur = now.hour * 60 + now.minute;
    final f = mins(timeFrom), t = mins(timeTo);
    if (f == t) return true;
    if (f < t) return cur >= f && cur <= t;
    return cur >= f || cur <= t; // crosses midnight
  }

  factory GpsConfig.fromJson(Map<String, dynamic> j) {
    final locs = (j['locations'] is List) ? j['locations'] as List : const [];
    int toInt(Object? v, int d) {
      if (v is num) return v.toInt();
      return int.tryParse('${v ?? ''}') ?? d;
    }
    return GpsConfig(
      enabled: j['enabled'] == true,
      trackHourly: j['track_hourly'] == true,
      hourlyIntervalMin: toInt(j['hourly_interval_min'], 60),
      trackPartVisit: j['track_part_visit'] == true,
      trackOnCreate: j['track_on_create'] == true,
      timeFrom: (j['time_from'] ?? '07:00').toString(),
      timeTo: (j['time_to'] ?? '20:00').toString(),
      minMoveM: toInt(j['min_move_m'], 100),
      withinWindow: j['within_window'] == true,
      locations: locs
          .whereType<Map>()
          .map((m) => GpsBeat.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
    );
  }
}

class GpsBeat {
  const GpsBeat({required this.id, required this.name});
  final int id;
  final String name;
  factory GpsBeat.fromJson(Map<String, dynamic> j) => GpsBeat(
        id: (j['id'] is num) ? (j['id'] as num).toInt() : int.tryParse('${j['id']}') ?? 0,
        name: (j['name'] ?? '').toString(),
      );
}
