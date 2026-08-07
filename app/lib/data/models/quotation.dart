import 'voucher_item.dart';

/// One quotation (भाव-पत्र) from `GET /api/v1/quotations`, and its line items
/// from `GET /api/v1/quotations/:id`.
///
/// Mirrors the `quotations` / `quotation_items` tables. pg returns numeric and
/// bigint columns as STRINGS, so every coercion below is defensive.
///
/// Two independent statuses ride on a quotation — do not conflate them:
///   • [quoteStatus]  — the DEAL lifecycle: open / accepted / rejected /
///     expired ('expired' is DERIVED by the API from `valid_till`).
///   • [status]       — the Tally-sync lifecycle, the same field every other
///     voucher carries (draft_cloud / pending_tally / sent_to_tally / …).
class Quotation {
  const Quotation({
    required this.id,
    required this.quotationNo,
    this.customerId,
    this.customer,
    this.locationId,
    this.location,
    this.salesPersonId,
    this.quotationDate,
    this.validTill,
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
    this.quoteStatus,
    this.convertedInvoiceId,
    this.status,
    this.notes,
    this.createdAt,
    this.items = const [],
  });

  final int id;
  final String quotationNo;

  final int? customerId;
  final String? customer;
  final int? locationId;
  final String? location;
  final int? salesPersonId;

  final String? quotationDate;
  final String? validTill;
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

  /// Deal lifecycle: open | accepted | rejected | expired.
  final String? quoteStatus;

  /// Set once the quotation has been converted into a sales invoice.
  final int? convertedInvoiceId;

  /// Tally-sync lifecycle.
  final String? status;

  final String? notes;
  final String? createdAt;

  /// Only populated by the detail endpoint; the list rows carry no items.
  final List<QuotationItem> items;

  bool get isConverted => convertedInvoiceId != null;

  factory Quotation.fromJson(Map<String, dynamic> j) => Quotation(
        id: _toInt(j['id']) ?? 0,
        quotationNo: _s(j['quotation_no']),
        customerId: _toInt(j['customer_id']),
        customer: _sn(j['customer']),
        locationId: _toInt(j['location_id']),
        location: _sn(j['location']),
        salesPersonId: _toInt(j['sales_person_id']),
        quotationDate: _sn(j['quotation_date']),
        validTill: _sn(j['valid_till']),
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
        quoteStatus: _sn(j['quote_status']),
        convertedInvoiceId: _toInt(j['converted_invoice_id']),
        status: _sn(j['status']),
        notes: _sn(j['notes']),
        createdAt: _sn(j['created_at']),
        items: VoucherItem.listFrom(j['items']),
      );
}

/// A quotation line — the shared item shape every item-style voucher uses.
typedef QuotationItem = VoucherItem;

/// Human label for the DEAL lifecycle (`quote_status`).
String quoteStatusLabel(String? s) {
  switch (s) {
    case 'open':
      return 'Open';
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
    default:
      return s == null || s.isEmpty ? 'Open' : s;
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
