/// One customer row from `GET /api/v1/customers` (list) — Node left-joins the
/// location + sales-person names onto the row. Numeric/bigint columns arrive as
/// strings from the pg driver, so all coercions are defensive.
class Customer {
  const Customer({
    required this.id,
    required this.name,
    this.mobile,
    this.email,
    this.gstNumber,
    this.location,
    this.salesPerson,
    this.openingBalance,
    this.creditLimit,
    this.status,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? mobile;
  final String? email;
  final String? gstNumber;
  final String? location;     // joined location name
  final String? salesPerson;  // joined sales-person name
  final num? openingBalance;
  final num? creditLimit;
  final String? status;       // Active | Inactive | Blocked
  final String? createdAt;

  factory Customer.fromJson(Map<String, dynamic> j) => Customer(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        mobile: _sn(j['mobile']),
        email: _sn(j['email']),
        gstNumber: _sn(j['gst_number']),
        location: _sn(j['location']),
        salesPerson: _sn(j['sales_person']),
        openingBalance: _toNum(j['opening_balance']),
        creditLimit: _toNum(j['credit_limit']),
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

  static num? _toNum(Object? v) {
    if (v == null) return null;
    if (v is num) return v;
    final s = v.toString().trim();
    return s.isEmpty ? null : num.tryParse(s);
  }
}
