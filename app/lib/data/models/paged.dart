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
  const OptionItem({
    required this.id, required this.name,
    this.locationId, this.locationName,
    this.stock, this.rate, this.gstRate,
    this.hsn, this.unit,
    this.balance,
  });
  final int id;
  final String name;

  /// Present on product options — stock ON HAND (opening plus everything
  /// received, less everything issued), the effective rate (sales_price;
  /// already price-list-adjusted for a customer-portal login) and the GST %.
  /// Drives the line's rate/GST auto-fill and the "In stock" hint.
  ///
  /// Read from `closing_stock`, NOT `opening_stock`: opening is where the item
  /// STARTED and is routinely 0 on a synced item, which made every line report
  /// "In stock: 0" for goods that were on the shelf.
  final double? stock;
  final double? rate;
  final double? gstRate;

  /// Present on party options — the synced Tally closing balance, so the
  /// picker can show where a customer or supplier stands before you raise a
  /// voucher against them. Null when the party has no synced ledger, which is
  /// deliberately different from a balance of zero.
  final double? balance;

  /// Present on product options — the HSN/SAC code and unit of measure. Invoice
  /// lines carry both to the API (the web does the same), so a voucher records
  /// what was actually sold, not just its id.
  final String? hsn;
  final String? unit;

  /// Present on customer options — the customer's own location (id + label), so
  /// picking a customer AUTO-fills the invoice's Location field (mirrors the web).
  final int? locationId;
  final String? locationName;

  factory OptionItem.fromJson(Map<String, dynamic> j) => OptionItem(
        id: _toInt(j['id']) ?? 0,
        name: (j['name'] ?? '').toString(),
        locationId: _toInt(j['location_id']),
        locationName: (j['location'] == null) ? null : j['location'].toString(),
        // closing_stock first; opening_stock only as a fallback for an older
        // API that does not send it yet.
        stock: _toDouble(j['closing_stock'] ?? j['opening_stock']),
        rate: _toDouble(j['rate'] ?? j['sales_price']),
        gstRate: _toDouble(j['gst_rate']),
        hsn: _str(j['hsn'] ?? j['hsn_code']),
        unit: _str(j['unit']),
        balance: _toDouble(j['closing_balance']),
      );

  @override
  bool operator ==(Object other) => other is OptionItem && other.id == id;
  @override
  int get hashCode => id;
}

String? _str(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

double? _toDouble(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  final s = v.toString().trim();
  return s.isEmpty ? null : double.tryParse(s);
}

int? _toInt(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toInt();
  final s = v.toString().trim();
  return s.isEmpty ? null : int.tryParse(s);
}
