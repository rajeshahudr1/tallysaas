// Shared shapes for the TallySaaS list endpoints, which all return the
// envelope `data` as `{ data: [...rows], meta: { total, page, per_page } }`.

/// A page of rows of type [T] plus its pagination meta. Repositories map the
/// raw `data` payload into `PagedResult<T>` so controllers can append pages
/// and know when more remain.
class PagedResult<T> {
  const PagedResult({
    required this.items,
    required this.total,
    required this.page,
    required this.perPage,
  });

  final List<T> items;
  final int total;
  final int page;
  final int perPage;

  /// True when there are more pages to fetch (for infinite-scroll / load-more).
  bool get hasMore => page * perPage < total;

  /// Builds a result from a list endpoint's unwrapped `data` object by mapping
  /// each row map through [fromRow]. Tolerant of a bare list (no meta) too.
  factory PagedResult.fromData(
    dynamic data,
    T Function(Map<String, dynamic>) fromRow,
  ) {
    if (data is List) {
      final items = data
          .whereType<Map>()
          .map((m) => fromRow(m.cast<String, dynamic>()))
          .toList(growable: false);
      return PagedResult<T>(items: items, total: items.length, page: 1, perPage: items.length);
    }
    final map = (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
    final rows = (map['data'] is List) ? map['data'] as List : const [];
    final meta = (map['meta'] is Map) ? (map['meta'] as Map).cast<String, dynamic>() : const {};
    final items = rows
        .whereType<Map>()
        .map((m) => fromRow(m.cast<String, dynamic>()))
        .toList(growable: false);
    return PagedResult<T>(
      items: items,
      total: _toInt(meta['total']) ?? items.length,
      page: _toInt(meta['page']) ?? 1,
      perPage: _toInt(meta['per_page']) ?? items.length,
    );
  }
}

/// A `{id, name}` option for an FK dropdown (Location, Sales Person, Category,
/// …). Always fetched from the API — never hardcoded — so web + app stay in
/// sync. Maps the same {id,name} rows the web's `fetchOptions` consumes.
class OptionItem {
  const OptionItem({required this.id, required this.name});
  final int id;
  final String name;

  factory OptionItem.fromJson(Map<String, dynamic> j) => OptionItem(
        id: _toInt(j['id']) ?? 0,
        name: (j['name'] ?? '').toString(),
      );

  @override
  bool operator ==(Object other) => other is OptionItem && other.id == id;
  @override
  int get hashCode => id;
}

int? _toInt(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toInt();
  final s = v.toString().trim();
  return s.isEmpty ? null : int.tryParse(s);
}
