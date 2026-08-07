import 'voucher_item.dart';

/// Which side of the books a return note sits on. The API exposes the SAME
/// controller under two paths with two permission slugs, so a role can be
/// granted one without the other.
enum ReturnNoteKind {
  /// Credit Note — goods coming BACK from a customer (mirrors a sales invoice).
  credit,

  /// Debit Note — goods going BACK to a supplier (mirrors a purchase invoice).
  debit,
}

extension ReturnNoteKindX on ReturnNoteKind {
  bool get isCredit => this == ReturnNoteKind.credit;

  /// API path + permission slug — 'credit-notes' / 'debit-notes'.
  String get slug => isCredit ? 'credit-notes' : 'debit-notes';

  String get path => '/$slug';

  String get title => isCredit ? 'Credit Notes' : 'Debit Notes';
  String get singular => isCredit ? 'Credit Note' : 'Debit Note';

  /// The party a note of this kind is raised against.
  String get partyLabel => isCredit ? 'Customer' : 'Supplier';

  /// The FK the API expects for that party.
  String get partyKey => isCredit ? 'customer_id' : 'supplier_id';

  /// The master endpoint the party picker reads.
  String get partyEndpoint => isCredit ? '/customers' : '/suppliers';
}

/// One credit / debit note. These live on the shared `invoices` table (the API
/// distinguishes them by `type`), so the payload looks like an invoice plus
/// two note-only fields: [againstInvoiceId] and [supplierBillNo].
class ReturnNote {
  const ReturnNote({
    required this.id,
    required this.invoiceNo,
    this.type,
    this.customerId,
    this.customer,
    this.supplierId,
    this.supplier,
    this.locationId,
    this.location,
    this.againstInvoiceId,
    this.supplierBillNo,
    this.invoiceDate,
    this.subtotal,
    this.discount,
    this.taxable,
    this.cgst,
    this.sgst,
    this.igst,
    this.taxAmount,
    this.roundOff,
    this.total,
    this.status,
    this.notes,
    this.createdAt,
    this.items = const [],
  });

  final int id;
  final String invoiceNo;

  /// 'credit_note' | 'debit_note' as stored on the invoices table.
  final String? type;

  final int? customerId;
  final String? customer;
  final int? supplierId;
  final String? supplier;
  final int? locationId;
  final String? location;

  /// The original invoice this note reverses, when one was picked.
  final int? againstInvoiceId;

  /// Debit notes only — the supplier's own bill reference.
  final String? supplierBillNo;

  final String? invoiceDate;

  final num? subtotal;
  final num? discount;
  final num? taxable;
  final num? cgst;
  final num? sgst;
  final num? igst;
  final num? taxAmount;
  final num? roundOff;
  final num? total;

  /// Tally-sync lifecycle.
  final String? status;

  final String? notes;
  final String? createdAt;

  final List<VoucherItem> items;

  /// The party name for whichever side this note belongs to.
  String? party(ReturnNoteKind kind) => kind.isCredit ? customer : supplier;

  int? partyId(ReturnNoteKind kind) => kind.isCredit ? customerId : supplierId;

  factory ReturnNote.fromJson(Map<String, dynamic> j) => ReturnNote(
        id: _toInt(j['id']) ?? 0,
        invoiceNo: (j['invoice_no'] ?? '').toString(),
        type: _sn(j['type']),
        customerId: _toInt(j['customer_id']),
        customer: _sn(j['customer']),
        supplierId: _toInt(j['supplier_id']),
        supplier: _sn(j['supplier']),
        locationId: _toInt(j['location_id']),
        location: _sn(j['location']),
        againstInvoiceId: _toInt(j['against_invoice_id']),
        supplierBillNo: _sn(j['supplier_bill_no']),
        invoiceDate: _sn(j['invoice_date']),
        subtotal: _toNum(j['subtotal']),
        discount: _toNum(j['discount']),
        taxable: _toNum(j['taxable']),
        cgst: _toNum(j['cgst']),
        sgst: _toNum(j['sgst']),
        igst: _toNum(j['igst']),
        taxAmount: _toNum(j['tax_amount']),
        roundOff: _toNum(j['round_off']),
        total: _toNum(j['total']),
        status: _sn(j['status']),
        notes: _sn(j['notes']),
        createdAt: _sn(j['created_at']),
        items: VoucherItem.listFrom(j['items']),
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
