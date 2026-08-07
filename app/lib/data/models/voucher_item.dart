/// One line on an item-style voucher — quotations, sales orders, purchase
/// orders, delivery/receipt notes. Every one of those tables carries the SAME
/// line columns, so they share this model instead of copying it per module.
///
/// The money columns (taxable / gst_amount / amount) are computed SERVER-side
/// from quantity / rate / discount_pct / gst_rate / tax_inclusive — [toJson]
/// deliberately omits them so a client can never push its own totals.
class VoucherItem {
  const VoucherItem({
    this.id,
    this.productId,
    this.description,
    this.hsn,
    this.quantity,
    this.unit,
    this.rate,
    this.discountPct,
    this.taxable,
    this.gstRate,
    this.gstAmount,
    this.amount,
    this.godown,
    this.taxInclusive = false,
  });

  final int? id;
  final int? productId;
  final String? description;
  final String? hsn;
  final num? quantity;
  final String? unit;
  final num? rate;
  final num? discountPct;
  final num? taxable;
  final num? gstRate;
  final num? gstAmount;
  final num? amount;
  final String? godown;
  final bool taxInclusive;

  factory VoucherItem.fromJson(Map<String, dynamic> j) => VoucherItem(
        id: _toInt(j['id']),
        productId: _toInt(j['product_id']),
        description: _sn(j['description']),
        hsn: _sn(j['hsn']),
        quantity: _toNum(j['quantity']),
        unit: _sn(j['unit']),
        rate: _toNum(j['rate']),
        discountPct: _toNum(j['discount_pct']),
        taxable: _toNum(j['taxable']),
        gstRate: _toNum(j['gst_rate']),
        gstAmount: _toNum(j['gst_amount']),
        amount: _toNum(j['amount']),
        godown: _sn(j['godown']),
        taxInclusive: j['tax_inclusive'] == true,
      );

  /// The write shape the API item schemas accept.
  Map<String, dynamic> toJson() => {
        if (productId != null) 'product_id': productId,
        'description': description ?? '',
        'hsn': hsn ?? '',
        'quantity': quantity ?? 0,
        'unit': unit ?? '',
        'rate': rate ?? 0,
        'discount_pct': discountPct ?? 0,
        'gst_rate': gstRate ?? 0,
        'godown': godown ?? '',
        'tax_inclusive': taxInclusive,
      };

  static List<VoucherItem> listFrom(Object? raw) => (raw is List)
      ? raw
          .whereType<Map>()
          .map((m) => VoucherItem.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false)
      : const [];
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
