/// One supplier row (Tally "sundry creditor") from `GET /api/v1/suppliers`.
/// Node left-joins the location name onto the row (`locations.name as location`).
/// pg returns numeric/bigint columns as strings, so coercions are defensive.
class Supplier {
  const Supplier({
    required this.id,
    required this.name,
    this.mobile,
    this.email,
    this.gstNumber,
    this.supplierGroup,
    this.location,
    this.openingBalance,
    this.paymentTerms,
    this.status,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? mobile;
  final String? email;
  final String? gstNumber;
  final String? supplierGroup;
  final String? location; // joined location name
  final num? openingBalance;
  final String? paymentTerms;
  final String? status; // Active | Inactive | Blocked
  final String? createdAt;

  factory Supplier.fromJson(Map<String, dynamic> j) => Supplier(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        mobile: _sn(j['mobile']),
        email: _sn(j['email']),
        gstNumber: _sn(j['gst_number']),
        supplierGroup: _sn(j['supplier_group']),
        location: _sn(j['location']),
        openingBalance: _toNum(j['opening_balance']),
        paymentTerms: _sn(j['payment_terms']),
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
