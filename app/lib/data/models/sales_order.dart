import 'voucher_item.dart';

/// One sales order from `GET /api/v1/sales-orders` (and its lines from
/// `GET /api/v1/sales-orders/:id`). Mirrors the `sales_orders` /
/// `sales_order_items` tables; pg returns numerics as strings, so the
/// coercions are defensive.
///
/// Two independent statuses ride on an order — do not conflate them:
///   • [orderStatus] — the DELIVERY lifecycle: pending / partially_delivered /
///     delivered / cancelled.
///   • [status]      — the Tally-sync lifecycle every voucher carries.
class SalesOrder {
  const SalesOrder({
    required this.id,
    required this.orderNo,
    this.customerId,
    this.customer,
    this.locationId,
    this.location,
    this.salesPersonId,
    this.orderDate,
    this.dueOn,
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
    this.orderStatus,
    this.convertedInvoiceId,
    this.status,
    this.notes,
    this.createdAt,
    this.items = const [],
  });

  final int id;
  final String orderNo;

  final int? customerId;
  final String? customer;
  final int? locationId;
  final String? location;
  final int? salesPersonId;

  final String? orderDate;

  /// When the goods are due to be delivered.
  final String? dueOn;
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

  /// pending | partially_delivered | delivered | cancelled.
  final String? orderStatus;

  /// Set once the order has been converted into a sales invoice.
  final int? convertedInvoiceId;

  /// Tally-sync lifecycle.
  final String? status;

  final String? notes;
  final String? createdAt;

  /// Only populated by the detail endpoint.
  final List<VoucherItem> items;

  bool get isConverted => convertedInvoiceId != null;

  factory SalesOrder.fromJson(Map<String, dynamic> j) => SalesOrder(
        id: _toInt(j['id']) ?? 0,
        orderNo: (j['order_no'] ?? '').toString(),
        customerId: _toInt(j['customer_id']),
        customer: _sn(j['customer']),
        locationId: _toInt(j['location_id']),
        location: _sn(j['location']),
        salesPersonId: _toInt(j['sales_person_id']),
        orderDate: _sn(j['order_date']),
        dueOn: _sn(j['due_on']),
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
        orderStatus: _sn(j['order_status']),
        convertedInvoiceId: _toInt(j['converted_invoice_id']),
        status: _sn(j['status']),
        notes: _sn(j['notes']),
        createdAt: _sn(j['created_at']),
        items: VoucherItem.listFrom(j['items']),
      );
}

/// Human label for the DELIVERY lifecycle (`order_status`).
String orderStatusLabel(String? s) {
  switch (s) {
    case 'pending':
      return 'Pending';
    case 'partially_delivered':
      return 'Partial';
    case 'delivered':
      return 'Delivered';
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
