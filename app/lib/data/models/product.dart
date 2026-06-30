/// One product row (Tally stock item). The LIST (`GET /products`) sends a lean
/// projection (Node left-joins the category name on); the DETAIL
/// (`GET /products/:id`) sends every editable column so the Edit form can
/// pre-fill. pg returns numeric/bigint columns as strings, so coercions are
/// defensive.
class Product {
  const Product({
    required this.id,
    required this.name,
    this.sku,
    this.unit,
    this.hsnCode,
    this.gstRate,
    this.purchasePrice,
    this.salesPrice,
    this.openingStock,
    this.category,
    this.categoryId,
    this.description,
    this.isTallyItem,
    this.status,
    this.customFields = const {},
    this.createdAt,
  });

  final int id;
  final String name;
  final String? sku;
  final String? unit;
  final String? hsnCode;
  final num? gstRate;
  final num? purchasePrice;
  final num? salesPrice;
  final num? openingStock;
  final String? category;   // joined category name (list)
  final int? categoryId;    // FK id (detail) — drives the Edit form dropdown
  final String? description;
  final bool? isTallyItem;
  final String? status;     // Active | Inactive | Blocked
  final Map<String, dynamic> customFields;
  final String? createdAt;

  factory Product.fromJson(Map<String, dynamic> j) => Product(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        sku: _sn(j['sku']),
        unit: _sn(j['unit']),
        hsnCode: _sn(j['hsn_code']),
        gstRate: _toNum(j['gst_rate']),
        purchasePrice: _toNum(j['purchase_price']),
        salesPrice: _toNum(j['sales_price']),
        openingStock: _toNum(j['opening_stock']),
        category: _sn(j['category']),
        categoryId: _toInt(j['category_id']),
        description: _sn(j['description']),
        isTallyItem: _toBool(j['is_tally_item']),
        status: _sn(j['status']),
        customFields: _toMap(j['custom_fields']),
        createdAt: _sn(j['created_at']),
      );

  /// GST rate as the config-dropdown LABEL ("18%"), or null. Whole numbers drop
  /// the ".0" so it matches the `gst_rates` option list exactly.
  String? get gstRateLabel {
    final r = gstRate;
    if (r == null) return null;
    return (r % 1 == 0) ? '${r.toInt()}%' : '$r%';
  }

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
