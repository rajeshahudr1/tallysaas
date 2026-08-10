/// One supplier row (Tally "sundry creditor"). The LIST (`GET /suppliers`)
/// sends a lean projection (Node left-joins the location name on); the DETAIL
/// (`GET /suppliers/:id`) sends every editable column so the Edit form can
/// pre-fill. `fromJson` tolerates both. pg returns numeric/bigint columns as
/// strings, so coercions are defensive.
class Supplier {
  const Supplier({
    required this.id,
    required this.name,
    this.mobile,
    this.alternateMobile,
    this.email,
    this.gstNumber,
    this.panNumber,
    this.supplierGroup,
    this.location,
    this.locationId,
    this.address,
    this.openingBalance,
    this.paymentTerms,
    this.creditDays,
    this.closingBalance,
    this.lastPurchasedDate,
    this.tallyLedgerGroup,
    this.isTallyLedger,
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
  final String? supplierGroup;
  final String? location; // joined location name (list)
  final int? locationId;  // FK id (detail) — drives the Edit form dropdown
  final String? address;
  final num? openingBalance;
  final String? paymentTerms;

  /// Credit PERIOD, in days — the numeric counterpart to [paymentTerms].
  /// NULL means "no agreed terms", deliberately NOT 0.
  final int? creditDays;

  /// Where the supplier stands TODAY, from the synced Tally ledger.
  final num? closingBalance;

  /// When we last bought from them; null when we never have.
  final String? lastPurchasedDate;

  /// The supplier's group in Tally, kept apart from the cloud's own
  /// `supplier_group` so neither silently overwrites the other.
  final String? tallyLedgerGroup;
  final bool? isTallyLedger;
  final String? status; // Active | Inactive | Blocked
  final Map<String, dynamic> customFields;
  final String? createdAt;

  factory Supplier.fromJson(Map<String, dynamic> j) => Supplier(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        mobile: _sn(j['mobile']),
        alternateMobile: _sn(j['alternate_mobile']),
        email: _sn(j['email']),
        gstNumber: _sn(j['gst_number']),
        panNumber: _sn(j['pan_number']),
        supplierGroup: _sn(j['supplier_group']),
        location: _sn(j['location']),
        locationId: _toInt(j['location_id']),
        address: _sn(j['address']),
        openingBalance: _toNum(j['opening_balance']),
        paymentTerms: _sn(j['payment_terms']),
        creditDays: _toInt(j['credit_days']),
        closingBalance: _toNum(j['closing_balance']),
        lastPurchasedDate: _sn(j['last_purchased_date']),
        tallyLedgerGroup: _sn(j['tally_ledger_group']),
        isTallyLedger: _toBool(j['is_tally_ledger']),
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
