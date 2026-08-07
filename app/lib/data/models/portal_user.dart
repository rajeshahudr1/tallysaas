/// Portals — the two customer-facing logins.
///
///   • Customer User — an existing CUSTOMER given a login, so they can see
///     their own invoices and a catalog you scope for them.
///   • Website User  — a third-party API consumer: its own customers row plus
///     a login and an api_token, with its own cash / online pricing.
library;

/// A customer row as the Customer Users screen needs it: who they are and
/// whether a login has been attached yet.
class CustomerUser {
  const CustomerUser({
    required this.id,
    required this.name,
    this.mobile,
    this.email,
    this.group,
    this.status,
    this.userId,
  });

  final int id;
  final String name;
  final String? mobile;
  final String? email;
  final String? group;
  final String? status;

  /// The linked login's user id — null means "no portal login yet".
  final int? userId;

  bool get hasLogin => userId != null;

  factory CustomerUser.fromJson(Map<String, dynamic> j) => CustomerUser(
        id: _toInt(j['id']) ?? 0,
        name: (j['name'] ?? '').toString(),
        mobile: _sn(j['mobile']),
        email: _sn(j['email']),
        group: _sn(j['customer_group']),
        status: _sn(j['status']),
        userId: _toInt(j['user_id']),
      );
}

/// One category's pricing rule in a customer's catalog. A category may carry a
/// discount OR an addition — never both; the API rejects the pair.
class CatalogEntry {
  const CatalogEntry({
    required this.categoryId,
    this.categoryName,
    this.discountPct = 0,
    this.additionPct = 0,
    this.productIds = const [],
  });

  final int categoryId;
  final String? categoryName;
  final num discountPct;
  final num additionPct;
  final List<int> productIds;

  factory CatalogEntry.fromJson(Map<String, dynamic> j) => CatalogEntry(
        categoryId: _toInt(j['category_id']) ?? 0,
        categoryName: _sn(j['category'] ?? j['category_name']),
        discountPct: _toNum(j['discount_pct']) ?? 0,
        additionPct: _toNum(j['addition_pct']) ?? 0,
        productIds: (j['product_ids'] is List)
            ? (j['product_ids'] as List)
                .map(_toInt)
                .whereType<int>()
                .toList(growable: false)
            : const [],
      );

  Map<String, dynamic> toJson() => {
        'category_id': categoryId,
        'discount_pct': discountPct,
        'addition_pct': additionPct,
        'product_ids': productIds,
      };

  CatalogEntry copyWith({num? discountPct, num? additionPct, List<int>? productIds}) =>
      CatalogEntry(
        categoryId: categoryId,
        categoryName: categoryName,
        discountPct: discountPct ?? this.discountPct,
        additionPct: additionPct ?? this.additionPct,
        productIds: productIds ?? this.productIds,
      );
}

/// A third-party API consumer. The token is shown once on create / regenerate —
/// the API does not hand it back afterwards.
class WebsiteUser {
  const WebsiteUser({
    required this.id,
    required this.name,
    this.email,
    this.mobile,
    this.status,
    this.cashExtraPct,
    this.onlineExtraPct,
    this.apiToken,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? email;
  final String? mobile;
  final String? status;

  /// Price uplift applied to cash / online orders from this consumer.
  final num? cashExtraPct;
  final num? onlineExtraPct;

  final String? apiToken;
  final String? createdAt;

  factory WebsiteUser.fromJson(Map<String, dynamic> j) => WebsiteUser(
        id: _toInt(j['id']) ?? 0,
        name: (j['name'] ?? '').toString(),
        email: _sn(j['email']),
        mobile: _sn(j['mobile']),
        status: _sn(j['status']),
        cashExtraPct: _toNum(j['cash_extra_pct']),
        onlineExtraPct: _toNum(j['online_extra_pct']),
        apiToken: _sn(j['api_token']),
        createdAt: _sn(j['created_at']),
      );
}

String? _sn(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

int? _toInt(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toInt();
  final s = v.toString().trim();
  return s.isEmpty ? null : int.tryParse(s);
}

num? _toNum(Object? v) {
  if (v == null) return null;
  if (v is num) return v;
  final s = v.toString().trim();
  return s.isEmpty ? null : num.tryParse(s);
}
