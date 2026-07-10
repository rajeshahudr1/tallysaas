/// The unwrapped `data` from `GET /field/my-dashboard` — the logged-in
/// salesman's field home. Numeric columns are coerced defensively (pg returns
/// bigint/numeric as strings).
class FieldDashboard {
  const FieldDashboard({
    required this.isSalesman,
    required this.locations,
    required this.stats,
    required this.attendance,
  });

  final bool isSalesman;
  final List<FieldLocation> locations;
  final FieldStats stats;
  final FieldAttendance attendance;

  factory FieldDashboard.fromJson(Map<String, dynamic> j) {
    final locs = (j['locations'] is List) ? j['locations'] as List : const [];
    return FieldDashboard(
      isSalesman: j['is_salesman'] == true,
      locations: locs
          .whereType<Map>()
          .map((m) => FieldLocation.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
      stats: FieldStats.fromJson(
          (j['stats'] is Map) ? (j['stats'] as Map).cast<String, dynamic>() : const {}),
      attendance: FieldAttendance.fromJson(
          (j['attendance'] is Map) ? (j['attendance'] as Map).cast<String, dynamic>() : const {}),
    );
  }

  static int toInt(Object? v) {
    if (v == null) return 0;
    if (v is num) return v.toInt();
    return int.tryParse(v.toString().trim()) ?? 0;
  }

  static double toDouble(Object? v) {
    if (v == null) return 0;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString().trim()) ?? 0;
  }

  static double? toDoubleOrNull(Object? v) {
    if (v == null) return null;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString().trim());
  }

  static String? str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }
}

class FieldLocation {
  const FieldLocation({
    required this.id,
    required this.name,
    this.city,
    this.state,
    this.status,
    required this.customers,
    required this.invoices,
    required this.salesValue,
  });

  final int id;
  final String name;
  final String? city;
  final String? state;
  final String? status;
  final int customers;
  final int invoices;
  final double salesValue;

  String get place => [city, state].where((s) => s != null && s.isNotEmpty).join(', ');
  bool get isActive => (status ?? '').toLowerCase() == 'active';

  factory FieldLocation.fromJson(Map<String, dynamic> j) => FieldLocation(
        id: FieldDashboard.toInt(j['id']),
        name: (j['name'] ?? '').toString(),
        city: FieldDashboard.str(j['city']),
        state: FieldDashboard.str(j['state']),
        status: FieldDashboard.str(j['status']),
        customers: FieldDashboard.toInt(j['customers']),
        invoices: FieldDashboard.toInt(j['invoices']),
        salesValue: FieldDashboard.toDouble(j['sales_value']),
      );
}

class FieldStats {
  const FieldStats({
    this.locations = 0,
    this.customers = 0,
    this.todayVisited = 0,
    this.coveragePct = 0,
    this.draft = 0,
    this.pending = 0,
    this.approved = 0,
    this.rejected = 0,
    this.approvedValue = 0,
  });

  final int locations;
  final int customers;
  final int todayVisited;   // distinct outlets checked-in today (Phase 2)
  final int coveragePct;    // visited today / assigned customers
  final int draft;
  final int pending;
  final int approved;
  final int rejected;
  final double approvedValue;

  factory FieldStats.fromJson(Map<String, dynamic> j) => FieldStats(
        locations: FieldDashboard.toInt(j['locations']),
        customers: FieldDashboard.toInt(j['customers']),
        todayVisited: FieldDashboard.toInt(j['today_visited']),
        coveragePct: FieldDashboard.toInt(j['coverage_pct']),
        draft: FieldDashboard.toInt(j['draft']),
        pending: FieldDashboard.toInt(j['pending']),
        approved: FieldDashboard.toInt(j['approved']),
        rejected: FieldDashboard.toInt(j['rejected']),
        approvedValue: FieldDashboard.toDouble(j['approved_value']),
      );
}

/// Today's Start/End Day attendance state.
class FieldAttendance {
  const FieldAttendance({
    this.started = false,
    this.ended = false,
    this.startAt,
    this.endAt,
  });

  final bool started;
  final bool ended;
  final String? startAt;
  final String? endAt;

  factory FieldAttendance.fromJson(Map<String, dynamic> j) => FieldAttendance(
        started: j['started'] == true,
        ended: j['ended'] == true,
        startAt: FieldDashboard.str(j['start_at']),
        endAt: FieldDashboard.str(j['end_at']),
      );
}

/// One row from GET /field/visits — a check-in (with optional check-out).
class FieldVisit {
  const FieldVisit({
    required this.id,
    this.customer,
    this.customerId,
    this.customerMobile,
    this.location,
    this.salesPerson,
    this.checkinAt,
    this.checkoutAt,
    this.distanceM,
    this.within = false,
    this.note,
    this.status,
    this.lat,
    this.lng,
  });

  final int id;
  final String? customer;
  final int? customerId;
  final String? customerMobile;
  final String? location;
  final String? salesPerson;
  final String? checkinAt;
  final String? checkoutAt;
  final int? distanceM;
  final bool within;
  final String? note;
  final String? status;
  final double? lat;
  final double? lng;

  bool get isOpen => (status ?? '') == 'open';

  factory FieldVisit.fromJson(Map<String, dynamic> j) => FieldVisit(
        id: FieldDashboard.toInt(j['id']),
        customer: FieldDashboard.str(j['customer']),
        customerId: j['customer_id'] == null ? null : FieldDashboard.toInt(j['customer_id']),
        customerMobile: FieldDashboard.str(j['customer_mobile']),
        location: FieldDashboard.str(j['location']),
        salesPerson: FieldDashboard.str(j['sales_person']),
        checkinAt: FieldDashboard.str(j['checkin_at']),
        checkoutAt: FieldDashboard.str(j['checkout_at']),
        distanceM: j['checkin_distance_m'] == null
            ? null
            : FieldDashboard.toInt(j['checkin_distance_m']),
        within: j['checkin_within'] == true,
        note: FieldDashboard.str(j['note']),
        status: FieldDashboard.str(j['status']),
        lat: FieldDashboard.toDoubleOrNull(j['checkin_lat']),
        lng: FieldDashboard.toDoubleOrNull(j['checkin_lng']),
      );
}
