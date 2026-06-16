/// One category row (Tally stock group) from `GET /api/v1/categories`. Node
/// self-joins the parent name (`parent.name as parent`). pg may return bigint
/// ids as strings, so coercions are defensive.
class Category {
  const Category({
    required this.id,
    required this.name,
    this.parent,
    this.status,
    this.createdAt,
  });

  final int id;
  final String name;
  final String? parent; // joined parent category name (null = top-level)
  final String? status; // Active | Inactive
  final String? createdAt;

  factory Category.fromJson(Map<String, dynamic> j) => Category(
        id: _toInt(j['id']) ?? 0,
        name: _s(j['name']),
        parent: _sn(j['parent']),
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
