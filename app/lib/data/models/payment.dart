/// One voucher row from `GET /api/v1/payments` (money out) or `/receipts`
/// (money in) — both live in the `payments` table, discriminated by `type`.
/// Node COALESCEs the supplier/customer name into a single `party` label. pg
/// returns numeric/bigint columns as strings, so coercions are defensive.
class Payment {
  const Payment({
    required this.id,
    required this.voucherNo,
    this.type,
    this.party,
    this.paymentDate,
    this.mode,
    this.amount,
    this.reference,
    this.bankAccount,
    this.status,
    this.notes,
    this.createdAt,
  });

  final int id;
  final String voucherNo;
  final String? type; // payment | receipt
  final String? party; // COALESCE(supplier, customer) name
  final String? paymentDate;
  final String? mode;
  final num? amount;
  final String? reference;
  final String? bankAccount;
  final String? status; // pending_tally | sent_to_tally | created | failed
  final String? notes;
  final String? createdAt;

  factory Payment.fromJson(Map<String, dynamic> j) => Payment(
        id: _toInt(j['id']) ?? 0,
        voucherNo: _s(j['voucher_no']),
        type: _sn(j['type']),
        party: _sn(j['party']),
        paymentDate: _sn(j['payment_date']),
        mode: _sn(j['mode']),
        amount: _toNum(j['amount']),
        reference: _sn(j['reference']),
        bankAccount: _sn(j['bank_account']),
        status: _sn(j['status']),
        notes: _sn(j['notes']),
        createdAt: _sn(j['created_at']),
      );

  static String _s(Object? v) => v == null ? '' : v.toString();
  static String? _sn(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  static int? _toInt(Object? v) {
    if (v == null) return null;
    if (v is num) return v.toInt();
    final s = v.toString().trim();
    return s.isEmpty ? null : int.tryParse(s);
  }

  static num? _toNum(Object? v) {
    if (v == null) return null;
    if (v is num) return v;
    final s = v.toString().trim();
    return s.isEmpty ? null : num.tryParse(s);
  }
}
