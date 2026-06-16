/// One location row (Tally godown / branch) from `GET /api/v1/locations`.
/// No joins — all columns are on the row. pg may return bigint ids as strings.
class Location {
  const Location({
    required this.id,
    required this.name,
    this.code,
    this.city,
    this.state,
    this.pincode,
    this.mobile,
    this.manager,
    this.status,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? code;
  final String? city;
  final String? state;
  final String? pincode;
  final String? mobile;
  final String? manager;
  final String? status; // Active | Inactive
  final String? createdAt;

  factory Location.fromJson(Map<String, dynamic> j) => Location(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        code: _sn(j['code']),
        city: _sn(j['city']),
        state: _sn(j['state']),
        pincode: _sn(j['pincode']),
        mobile: _sn(j['mobile']),
        manager: _sn(j['manager']),
        status: _sn(j['status']),
        createdAt: _sn(j['created_at']),
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
