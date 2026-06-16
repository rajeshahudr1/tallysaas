/// One product row (Tally stock item) from `GET /api/v1/products`. Node
/// left-joins the category name onto the row (`categories.name as category`).
/// pg returns numeric/bigint columns as strings, so coercions are defensive.
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
    this.status,
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
  final String? category; // joined category name
  final String? status; // Active | Inactive
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
