import 'voucher_item.dart';

/// Which goods movement a note records. The two APIs are separate controllers
/// with parallel shapes, so the app models the difference as data rather than
/// shipping two near-identical modules.
enum GoodsNoteKind {
  /// Delivery Note — goods going OUT to a customer, before the sales invoice.
  delivery,

  /// Receipt Note — goods coming IN from a supplier, before their bill.
  receipt,
}

extension GoodsNoteKindX on GoodsNoteKind {
  bool get isDelivery => this == GoodsNoteKind.delivery;

  /// API path + permission slug.
  String get slug => isDelivery ? 'delivery-notes' : 'receipt-notes';
  String get path => '/$slug';

  String get title => isDelivery ? 'Delivery Notes' : 'Receipt Notes';
  String get singular => isDelivery ? 'Delivery Note' : 'Receipt Note';

  /// The party the note is raised against.
  String get partyLabel => isDelivery ? 'Customer' : 'Supplier';
  String get partyKey => isDelivery ? 'customer_id' : 'supplier_id';
  String get partyEndpoint => isDelivery ? '/customers' : '/suppliers';

  /// The list endpoint's own lifecycle filter — named per kind, NOT `status`
  /// (that is the Tally-sync lifecycle everywhere in this product).
  String get statusQueryKey => isDelivery ? 'delivery_status' : 'receipt_status';

  /// The second date column: when goods left / when they arrived.
  String get movementDateKey => isDelivery ? 'dispatch_date' : 'received_date';
  String get movementDateLabel => isDelivery ? 'Dispatch Date' : 'Received Date';

  /// The order this note can be raised against.
  String get orderKey => isDelivery ? 'sales_order_id' : 'purchase_order_id';
  String get orderLabel => isDelivery ? 'Sales Order' : 'Purchase Order';

  /// What converting the note produces.
  String get invoiceLabel => isDelivery ? 'Sales Invoice' : 'Purchase Invoice';
  String get invoicePath => isDelivery ? '/sales-invoices' : '/purchase-invoices';
}

/// One delivery / receipt note. Both tables carry the same columns apart from
/// the party, the movement date and the order FK — [GoodsNoteKind] supplies
/// those names, and this model normalises them into one shape.
class GoodsNote {
  const GoodsNote({
    required this.id,
    required this.noteNo,
    this.partyId,
    this.party,
    this.locationId,
    this.location,
    this.salesPersonId,
    this.orderId,
    this.noteDate,
    this.movementDate,
    this.ledgerName,
    this.subtotal,
    this.discount,
    this.taxable,
    this.cgst,
    this.sgst,
    this.igst,
    this.taxAmount,
    this.roundOff,
    this.total,
    this.noteStatus,
    this.convertedInvoiceId,
    this.status,
    this.notes,
    this.createdAt,
    this.items = const [],
  });

  final int id;
  final String noteNo;

  final int? partyId;
  final String? party;
  final int? locationId;
  final String? location;

  /// Delivery notes only.
  final int? salesPersonId;

  /// The sales / purchase order this note was raised against, if any.
  final int? orderId;

  final String? noteDate;

  /// Dispatch date (delivery) or received date (receipt).
  final String? movementDate;

  final String? ledgerName;

  final num? subtotal;
  final num? discount;
  final num? taxable;
  final num? cgst;
  final num? sgst;
  final num? igst;
  final num? taxAmount;
  final num? roundOff;
  final num? total;

  /// pending | invoiced | cancelled — the note's own lifecycle.
  final String? noteStatus;

  final int? convertedInvoiceId;

  /// Tally-sync lifecycle.
  final String? status;

  final String? notes;
  final String? createdAt;

  final List<VoucherItem> items;

  bool get isConverted => convertedInvoiceId != null;

  /// Parses a row for [kind], reading the kind-specific column names.
  factory GoodsNote.fromJson(Map<String, dynamic> j, GoodsNoteKind kind) => GoodsNote(
        id: _toInt(j['id']) ?? 0,
        noteNo: (j['note_no'] ?? '').toString(),
        partyId: _toInt(j[kind.partyKey]),
        party: _sn(j[kind.isDelivery ? 'customer' : 'supplier']),
        locationId: _toInt(j['location_id']),
        location: _sn(j['location']),
        salesPersonId: _toInt(j['sales_person_id']),
        orderId: _toInt(j[kind.orderKey]),
        noteDate: _sn(j['note_date']),
        movementDate: _sn(j[kind.movementDateKey]),
        ledgerName: _sn(j['ledger_name']),
        subtotal: _toNum(j['subtotal']),
        discount: _toNum(j['discount']),
        taxable: _toNum(j['taxable']),
        cgst: _toNum(j['cgst']),
        sgst: _toNum(j['sgst']),
        igst: _toNum(j['igst']),
        taxAmount: _toNum(j['tax_amount']),
        roundOff: _toNum(j['round_off']),
        total: _toNum(j['total']),
        noteStatus: _sn(j[kind.statusQueryKey]),
        convertedInvoiceId: _toInt(j['converted_invoice_id']),
        status: _sn(j['status']),
        notes: _sn(j['notes']),
        createdAt: _sn(j['created_at']),
        items: VoucherItem.listFrom(j['items']),
      );
}

/// Human label for a goods note's own lifecycle.
String goodsNoteStatusLabel(String? s) {
  switch (s) {
    case 'pending':
      return 'Pending';
    case 'invoiced':
      return 'Invoiced';
    case 'cancelled':
      return 'Cancelled';
    default:
      return s == null || s.isEmpty ? 'Pending' : s;
  }
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
