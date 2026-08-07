/// Stock Journal and Physical Stock — the two GOODS-ONLY vouchers. Neither
/// carries a party, a ledger, GST or money totals, so they do NOT reuse the
/// item-style voucher models; quantities are the whole story.
library;

/// One stock journal — a transfer / conversion of stock: quantities leave the
/// SOURCE lines and arrive on the DESTINATION lines. From `GET /stock-journals`
/// (list) and `/stock-journals/:id` (with items).
class StockJournal {
  const StockJournal({
    required this.id,
    required this.voucherNo,
    this.journalDate,
    this.narration,
    this.status,
    this.createdAt,
    this.items = const [],
  });

  final int id;
  final String voucherNo;
  final String? journalDate;
  final String? narration;

  /// Tally-sync lifecycle.
  final String? status;
  final String? createdAt;

  final List<StockJournalItem> items;

  /// Lines stock moves OUT of.
  List<StockJournalItem> get sources =>
      [for (final i in items) if (i.isSource) i];

  /// Lines stock moves IN to.
  List<StockJournalItem> get destinations =>
      [for (final i in items) if (!i.isSource) i];

  factory StockJournal.fromJson(Map<String, dynamic> j) => StockJournal(
        id: _toInt(j['id']) ?? 0,
        voucherNo: (j['voucher_no'] ?? '').toString(),
        journalDate: _sn(j['journal_date']),
        narration: _sn(j['narration']),
        status: _sn(j['status']),
        createdAt: _sn(j['created_at']),
        items: (j['items'] is List)
            ? (j['items'] as List)
                .whereType<Map>()
                .map((m) => StockJournalItem.fromJson(m.cast<String, dynamic>()))
                .toList(growable: false)
            : const [],
      );
}

/// One stock-journal line. [direction] is 'source' (stock out) or
/// 'destination' (stock in) — the API rejects anything else.
class StockJournalItem {
  const StockJournalItem({
    this.id,
    this.productId,
    this.productName,
    this.direction,
    this.godown,
    this.quantity,
    this.rate,
  });

  final int? id;
  final int? productId;
  final String? productName;
  final String? direction;
  final String? godown;
  final num? quantity;
  final num? rate;

  bool get isSource => direction == 'source';

  factory StockJournalItem.fromJson(Map<String, dynamic> j) => StockJournalItem(
        id: _toInt(j['id']),
        productId: _toInt(j['product_id']),
        productName: _sn(j['product_name'] ?? j['product']),
        direction: _sn(j['direction']),
        godown: _sn(j['godown']),
        quantity: _toNum(j['quantity']),
        rate: _toNum(j['rate']),
      );

  /// The write shape `POST /stock-journals` accepts.
  Map<String, dynamic> toJson() => {
        'product_id': productId,
        'direction': direction ?? 'source',
        'godown': godown ?? '',
        'quantity': quantity ?? 0,
        if (rate != null) 'rate': rate,
      };
}

/// One physical-stock SHEET — a stock count. The API stores each counted line
/// in `stock_adjustments` and groups them by `voucher_no`, so a sheet is
/// addressed by its voucher number, not an id.
class PhysicalStockSheet {
  const PhysicalStockSheet({
    required this.voucherNo,
    this.countDate,
    this.narration,
    this.itemCount,
    this.createdAt,
    this.items = const [],
  });

  final String voucherNo;
  final String? countDate;
  final String? narration;

  /// Only the LIST rows carry this (the API counts the grouped lines).
  final int? itemCount;
  final String? createdAt;

  final List<PhysicalStockItem> items;

  factory PhysicalStockSheet.fromJson(Map<String, dynamic> j) => PhysicalStockSheet(
        voucherNo: (j['voucher_no'] ?? '').toString(),
        countDate: _sn(j['count_date'] ?? j['adjustment_date']),
        narration: _sn(j['narration']),
        itemCount: _toInt(j['items'] is List ? null : j['items']),
        createdAt: _sn(j['created_at']),
        items: (j['items'] is List)
            ? (j['items'] as List)
                .whereType<Map>()
                .map((m) => PhysicalStockItem.fromJson(m.cast<String, dynamic>()))
                .toList(growable: false)
            : const [],
      );
}

/// One counted line on a physical-stock sheet.
class PhysicalStockItem {
  const PhysicalStockItem({
    this.id,
    this.productId,
    this.productName,
    this.productSku,
    this.countedQty,
    this.godown,
  });

  final int? id;
  final int? productId;
  final String? productName;
  final String? productSku;
  final num? countedQty;
  final String? godown;

  factory PhysicalStockItem.fromJson(Map<String, dynamic> j) => PhysicalStockItem(
        id: _toInt(j['id']),
        productId: _toInt(j['product_id']),
        productName: _sn(j['product_name']),
        productSku: _sn(j['product_sku']),
        // The stored column is `quantity`; the write side calls it counted_qty.
        countedQty: _toNum(j['counted_qty'] ?? j['quantity']),
        godown: _sn(j['godown']),
      );

  /// The write shape `POST /physical-stock` accepts.
  Map<String, dynamic> toJson() => {
        'product_id': productId,
        'counted_qty': countedQty ?? 0,
        'godown': godown ?? '',
      };
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
