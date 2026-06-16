/// One journal voucher (Dr/Cr two-ledger entry) from `GET /api/v1/journals`.
/// pg returns numeric/bigint columns as strings, so coercions are defensive.
class Journal {
  const Journal({
    required this.id,
    required this.voucherNo,
    this.vchType,
    this.journalDate,
    this.drLedger,
    this.crLedger,
    this.amount,
    this.narration,
    this.status,
    this.createdAt,
  });

  final int id;
  final String voucherNo;
  final String? vchType; // Journal | Contra | Credit Note | Debit Note
  final String? journalDate;
  final String? drLedger;
  final String? crLedger;
  final num? amount;
  final String? narration;
  final String? status;
  final String? createdAt;

  factory Journal.fromJson(Map<String, dynamic> j) => Journal(
        id: _toInt(j['id']) ?? 0,
        voucherNo: _s(j['voucher_no']),
        vchType: _sn(j['vch_type']),
        journalDate: _sn(j['journal_date']),
        drLedger: _sn(j['dr_ledger']),
        crLedger: _sn(j['cr_ledger']),
        amount: _toNum(j['amount']),
        narration: _sn(j['narration']),
        status: _sn(j['status']),
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
