/// One product row (Tally stock item). The LIST (`GET /products`) sends a lean
/// projection (Node left-joins the category name on); the DETAIL
/// (`GET /products/:id`) sends every editable column so the Edit form can
/// pre-fill. pg returns numeric/bigint columns as strings, so coercions are
/// defensive.
///
/// Both list + detail also carry the image gallery: `image_url` (the primary
/// photo, for a list thumbnail) and `images` (the full gallery, for detail).
/// The API builds ABSOLUTE urls server-side so the app never composes paths.
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
    this.closingStock,
    this.avgPurchaseRate,
    this.stockValue,
    this.category,
    this.categoryId,
    this.description,
    this.isTallyItem,
    this.status,
    this.customFields = const {},
    this.createdAt,
    this.imageUrl,
    this.images = const [],
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

  /// Where the item stands TODAY: opening plus everything received, less
  /// everything issued. [openingStock] alone is only where it started.
  final num? closingStock;

  /// Total spent on this item divided by the quantity bought. NULL (not 0)
  /// when we have never bought it — a zero would read as "we get it free".
  final num? avgPurchaseRate;

  /// What the stock on hand is WORTH: closing quantity at that average rate.
  /// NULL rather than 0 for an item never purchased — there is no rate to
  /// value it at, and 0 would read as worthless stock, not unvalued stock.
  final num? stockValue;
  final String? category;   // joined category name (list)
  final int? categoryId;    // FK id (detail) — drives the Edit form dropdown
  final String? description;
  final bool? isTallyItem;
  final String? status;     // Active | Inactive | Blocked
  final Map<String, dynamic> customFields;
  final String? createdAt;
  final String? imageUrl;              // primary gallery image (list thumbnail + detail)
  final List<ProductImage> images;     // full image gallery (detail)

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
        closingStock: _toNum(j['closing_stock']),
        avgPurchaseRate: _toNum(j['avg_purchase_rate']),
        stockValue: _toNum(j['stock_value']),
        category: _sn(j['category']),
        categoryId: _toInt(j['category_id']),
        description: _sn(j['description']),
        isTallyItem: _toBool(j['is_tally_item']),
        status: _sn(j['status']),
        customFields: _toMap(j['custom_fields']),
        createdAt: _sn(j['created_at']),
        imageUrl: _sn(j['image_url']),
        images: _toImages(j['images']),
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

  static List<ProductImage> _toImages(Object? v) {
    if (v is List) {
      return v
          .whereType<Map>()
          .map((m) => ProductImage.fromJson(m.cast<String, dynamic>()))
          .toList();
    }
    return const [];
  }
}

/// One gallery image for a product. The API always sends an ABSOLUTE `url`
/// (built server-side) so the app can render it directly — no path building.
class ProductImage {
  const ProductImage({required this.id, required this.url});
  final int id;
  final String url;

  factory ProductImage.fromJson(Map<String, dynamic> j) => ProductImage(
        id: (j['id'] is num) ? (j['id'] as num).toInt() : int.tryParse('${j['id']}') ?? 0,
        url: (j['url'] ?? '').toString(),
      );
}
