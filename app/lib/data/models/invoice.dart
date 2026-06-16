/// One invoice header from `GET /api/v1/sales-invoices` (or purchase). Node
/// left-joins customer / supplier / location names. The money columns are
/// computed server-side (never trust client totals). pg returns numeric/bigint
/// columns as strings, so coercions are defensive.
class Invoice {
  const Invoice({
    required this.id,
    required this.invoiceNo,
    this.type,
    this.customer,
    this.supplier,
    this.location,
    this.invoiceDate,
    this.dueDate,
    this.subtotal,
    this.discount,
    this.taxable,
    this.taxAmount,
    this.roundOff,
    this.total,
    this.status,
    this.notes,
    this.items = const [],
  });

  final int id;
  final String invoiceNo;
  final String? type; // sales | purchase
  final String? customer;
  final String? supplier;
  final String? location;
  final String? invoiceDate;
  final String? dueDate;
  final num? subtotal;
  final num? discount;
  final num? taxable;
  final num? taxAmount;
  final num? roundOff;
  final num? total;
  final String? status; // pending_tally | sent_to_tally | created | failed
  final String? notes;
  final List<InvoiceItem> items;

  /// The party label that applies to this voucher kind (customer for sales,
  /// supplier for purchase) — whichever the join filled in.
  String? get party => customer ?? supplier;

  factory Invoice.fromJson(Map<String, dynamic> j) {
    final rawItems = (j['items'] is List) ? j['items'] as List : const [];
    return Invoice(
      id: _toInt(j['id']) ?? 0,
      invoiceNo: _s(j['invoice_no']),
      type: _sn(j['type']),
      customer: _sn(j['customer']),
      supplier: _sn(j['supplier']),
      location: _sn(j['location']),
      invoiceDate: _sn(j['invoice_date']),
      dueDate: _sn(j['due_date']),
      subtotal: _toNum(j['subtotal']),
      discount: _toNum(j['discount']),
      taxable: _toNum(j['taxable']),
      taxAmount: _toNum(j['tax_amount']),
      roundOff: _toNum(j['round_off']),
      total: _toNum(j['total']),
      status: _sn(j['status']),
      notes: _sn(j['notes']),
      items: rawItems
          .whereType<Map>()
          .map((m) => InvoiceItem.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
    );
  }
}

/// One invoice line from `invoice_items` (returned nested on GET :id). The
/// taxable / gst_amount / amount are server-computed.
class InvoiceItem {
  const InvoiceItem({
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
  });

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

  factory InvoiceItem.fromJson(Map<String, dynamic> j) => InvoiceItem(
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
      );
}

/// A short, friendly label for the invoice sync-lifecycle status. The raw
/// values (`pending_tally`, `sent_to_tally`, `created`, `failed`) map to words
/// that also colour correctly via `statusColor` (prefix families).
String invoiceStatusLabel(String? s) {
  switch ((s ?? '').toLowerCase()) {
    case 'pending_tally':
      return 'Pending';
    case 'sent_to_tally':
      return 'Sent';
    case 'created':
      return 'Synced';
    case 'failed':
      return 'Failed';
    default:
      return (s == null || s.isEmpty) ? 'Unknown' : s;
  }
}

String _s(Object? v) => v == null ? '' : v.toString();
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
