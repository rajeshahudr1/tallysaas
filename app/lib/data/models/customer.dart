/// One customer row. The LIST (`GET /customers`) sends a lean projection (the
/// Node left-joins the location + sales-person NAMES on); the DETAIL
/// (`GET /customers/:id`) sends every editable column so the Edit form can
/// pre-fill. `fromJson` tolerates both — absent fields stay null. Numeric/bigint
/// columns arrive as strings from the pg driver, so all coercions are defensive.
class Customer {
  const Customer({
    required this.id,
    required this.name,
    this.mobile,
    this.alternateMobile,
    this.email,
    this.gstNumber,
    this.panNumber,
    this.location,
    this.salesPerson,
    this.locationId,
    this.salesPersonId,
    this.customerGroupId,
    this.shippingAddress,
    this.billingAddress,
    this.openingBalance,
    this.creditLimit,
    this.notes,
    this.internalRemarks,
    this.isTallyLedger,
    this.ledgerGroup,
    this.openingBalanceType,
    this.gstRegistrationType,
    this.country,
    this.state,
    this.city,
    this.pincode,
    this.status,
    this.customFields = const {},
    this.createdAt,
  });

  final int id;
  final String name;
  final String? mobile;
  final String? alternateMobile;
  final String? email;
  final String? gstNumber;
  final String? panNumber;
  final String? location;      // joined location name (list)
  final String? salesPerson;   // joined sales-person name (list)
  final int? locationId;       // FK ids (detail) — drive the Edit form dropdowns
  final int? salesPersonId;
  final int? customerGroupId;
  final String? shippingAddress;
  final String? billingAddress;
  final num? openingBalance;
  final num? creditLimit;
  final String? notes;
  final String? internalRemarks;
  final bool? isTallyLedger;

  /// Tally party-ledger fields the web form has always carried.
  final String? ledgerGroup;

  /// Which side the opening balance sits on: 'Cr' or 'Dr'.
  final String? openingBalanceType;

  /// GST registration type (Regular, Composition, Unregistered…).
  final String? gstRegistrationType;

  final String? country;
  final String? state;
  final String? city;
  final String? pincode;

  final String? status;        // Active | Inactive | Blocked
  final Map<String, dynamic> customFields;
  final String? createdAt;

  factory Customer.fromJson(Map<String, dynamic> j) => Customer(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        mobile: _sn(j['mobile']),
        alternateMobile: _sn(j['alternate_mobile']),
        email: _sn(j['email']),
        gstNumber: _sn(j['gst_number']),
        panNumber: _sn(j['pan_number']),
        location: _sn(j['location']),
        salesPerson: _sn(j['sales_person']),
        locationId: _toInt(j['location_id']),
        salesPersonId: _toInt(j['sales_person_id']),
        customerGroupId: _toInt(j['customer_group_id']),
        shippingAddress: _sn(j['shipping_address']),
        billingAddress: _sn(j['billing_address']),
        openingBalance: _toNum(j['opening_balance']),
        creditLimit: _toNum(j['credit_limit']),
        notes: _sn(j['notes']),
        internalRemarks: _sn(j['internal_remarks']),
        isTallyLedger: _toBool(j['is_tally_ledger']),
        ledgerGroup: _sn(j['ledger_group']),
        openingBalanceType: _sn(j['opening_balance_type']),
        gstRegistrationType: _sn(j['gst_registration_type']),
        country: _sn(j['country']),
        state: _sn(j['state']),
        city: _sn(j['city']),
        pincode: _sn(j['pincode']),
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

  static num? _toNum(Object? v) {
    if (v == null) return null;
    if (v is num) return v;
    final s = v.toString().trim();
    return s.isEmpty ? null : num.tryParse(s);
  }

  static bool? _toBool(Object? v) {
    if (v == null) return null;
    if (v is bool) return v;
    final s = v.toString().trim().toLowerCase();
    if (s.isEmpty) return null;
    return s == 'true' || s == '1' || s == 't' || s == 'yes';
  }

  static Map<String, dynamic> _toMap(Object? v) {
    if (v is Map) return v.cast<String, dynamic>();
    return const {};
  }
}
