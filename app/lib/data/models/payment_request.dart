/// Collect Payments — UPI-first payment requests raised against an invoice,
/// and the company settings that turn the feature on.
library;

/// One payment request. The amount is ALWAYS the invoice's own total (the API
/// reads it server-side and ignores anything a client sends), and `paid` is
/// only ever reached through the explicit mark-paid action.
class PaymentRequest {
  const PaymentRequest({
    required this.id,
    this.invoiceId,
    this.invoiceNo,
    this.customerId,
    this.customer,
    this.amount,
    this.token,
    this.status,
    this.note,
    this.createdAt,
  });

  final int id;
  final int? invoiceId;
  final String? invoiceNo;
  final int? customerId;
  final String? customer;
  final num? amount;

  /// `<licenseId>.<48 hex>` — the public /pay/:token link's secret half.
  final String? token;

  /// pending | paid | cancelled.
  final String? status;

  final String? note;
  final String? createdAt;

  bool get isPending => status == 'pending';

  factory PaymentRequest.fromJson(Map<String, dynamic> j) => PaymentRequest(
        id: _toInt(j['id']) ?? 0,
        invoiceId: _toInt(j['invoice_id']),
        invoiceNo: _sn(j['invoice_no']),
        customerId: _toInt(j['customer_id']),
        customer: _sn(j['customer']),
        amount: _toNum(j['amount']),
        token: _sn(j['token']),
        status: _sn(j['status']),
        note: _sn(j['note']),
        createdAt: _sn(j['created_at']),
      );
}

/// An invoice that still owes money — the pick-list for a new request.
class OutstandingInvoice {
  const OutstandingInvoice({
    required this.id,
    this.invoiceNo,
    this.customer,
    this.invoiceDate,
    this.total,
    this.paid,
    this.outstanding,
  });

  final int id;
  final String? invoiceNo;
  final String? customer;
  final String? invoiceDate;
  final num? total;
  final num? paid;

  /// total − paid, computed by the API; only positive rows are returned.
  final num? outstanding;

  factory OutstandingInvoice.fromJson(Map<String, dynamic> j) => OutstandingInvoice(
        id: _toInt(j['id']) ?? 0,
        invoiceNo: _sn(j['invoice_no']),
        customer: _sn(j['customer']),
        invoiceDate: _sn(j['invoice_date']),
        total: _toNum(j['total']),
        paid: _toNum(j['paid']),
        outstanding: _toNum(j['outstanding']),
      );
}

/// The company's Collect Payments settings — where the money should land.
class CollectPaymentSettings {
  const CollectPaymentSettings({
    this.enabled = false,
    this.upiVpa = '',
    this.payeeName = '',
  });

  final bool enabled;
  final String upiVpa;
  final String payeeName;

  factory CollectPaymentSettings.fromJson(Map<String, dynamic> j) =>
      CollectPaymentSettings(
        enabled: j['enabled'] == true,
        upiVpa: (j['upi_vpa'] ?? '').toString(),
        payeeName: (j['payee_name'] ?? '').toString(),
      );

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'upi_vpa': upiVpa,
        'payee_name': payeeName,
      };

  CollectPaymentSettings copyWith({bool? enabled, String? upiVpa, String? payeeName}) =>
      CollectPaymentSettings(
        enabled: enabled ?? this.enabled,
        upiVpa: upiVpa ?? this.upiVpa,
        payeeName: payeeName ?? this.payeeName,
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
