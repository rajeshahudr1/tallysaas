/// One company row. The LIST (`GET /companies`) sends a lean projection; the
/// DETAIL (`GET /companies/:id`) sends every editable column so the Edit form
/// can pre-fill. pg may return bigint ids as strings — coercions are defensive.
class Company {
  const Company({
    required this.id,
    required this.name,
    this.mailingName,
    this.email,
    this.mobile,
    this.phone,
    this.address,
    this.state,
    this.pincode,
    this.country,
    this.gstNumber,
    this.panNumber,
    this.financialYear,
    this.booksFrom,
    this.logo,
    this.status,
    this.customFields = const {},
    this.createdAt,
  });

  final int id;
  final String name;
  final String? mailingName;
  final String? email;
  final String? mobile;
  final String? phone;
  final String? address;
  final String? state;
  final String? pincode;
  final String? country;
  final String? gstNumber;
  final String? panNumber;
  final String? financialYear;
  final String? booksFrom;
  final String? logo;
  final String? status; // Active | Inactive | Blocked
  final Map<String, dynamic> customFields;
  final String? createdAt;

  factory Company.fromJson(Map<String, dynamic> j) => Company(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        mailingName: _sn(j['mailing_name']),
        email: _sn(j['email']),
        mobile: _sn(j['mobile']),
        phone: _sn(j['phone']),
        address: _sn(j['address']),
        state: _sn(j['state']),
        pincode: _sn(j['pincode']),
        country: _sn(j['country']),
        gstNumber: _sn(j['gst_number']),
        panNumber: _sn(j['pan_number']),
        financialYear: _sn(j['financial_year']),
        booksFrom: _sn(j['books_from']),
        logo: _sn(j['logo']),
        status: _sn(j['status']),
        customFields: _toMap(j['custom_fields']),
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

  static Map<String, dynamic> _toMap(Object? v) {
    if (v is Map) return v.cast<String, dynamic>();
    return const {};
  }
}
