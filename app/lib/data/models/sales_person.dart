/// One sales-person row from `GET /api/v1/sales-persons`. pg may return bigint
/// ids as strings, so coercions are defensive.
class SalesPerson {
  const SalesPerson({
    required this.id,
    required this.name,
    this.employeeCode,
    this.mobile,
    this.email,
    this.joiningDate,
    this.status,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? employeeCode;
  final String? mobile;
  final String? email;
  final String? joiningDate;
  final String? status; // Active | Inactive
  final String? createdAt;

  factory SalesPerson.fromJson(Map<String, dynamic> j) => SalesPerson(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        employeeCode: _sn(j['employee_code']),
        mobile: _sn(j['mobile']),
        email: _sn(j['email']),
        joiningDate: _sn(j['joining_date']),
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
