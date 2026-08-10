/// Tally ledger buckets and their period balances — the data behind the Cash,
/// Bank, Payables and Receivables screens, and behind one ledger's statement.
///
/// All four screens are the SAME endpoint (`GET /tally/ledgers?group=<bucket>`)
/// with a different group, so the app models the bucket as data rather than
/// shipping four screens.
library;

enum LedgerBucket { cash, bank, payables, receivables }

extension LedgerBucketX on LedgerBucket {
  /// The `group` query value the API expects.
  String get group => name;

  String get title {
    switch (this) {
      case LedgerBucket.cash:
        return 'Cash';
      case LedgerBucket.bank:
        return 'Bank';
      case LedgerBucket.payables:
        return 'Payables';
      case LedgerBucket.receivables:
        return 'Receivables';
    }
  }

  /// Permission slug — these screens are gated the way the web gates them.
  String get module {
    switch (this) {
      case LedgerBucket.cash:
      case LedgerBucket.bank:
        return 'cash-bank';
      case LedgerBucket.payables:
        return 'payables';
      case LedgerBucket.receivables:
        return 'receivables';
    }
  }

  String get route => '/${name == 'cash' ? 'cash' : name}';
}

/// One ledger row in a bucket list, with its period-derived balance. `balance`
/// is the MAGNITUDE and [dc] says which side it sits on — never negate one
/// against the other.
class LedgerRow {
  const LedgerRow({
    required this.name,
    this.parent,
    this.bucket,
    this.opening,
    this.debit,
    this.credit,
    this.closing,
    this.balance,
    this.dc,
  });

  final String name;
  final String? parent;
  final String? bucket;

  final num? opening;
  final num? debit;
  final num? credit;

  /// Signed closing balance.
  final num? closing;

  /// Display magnitude of [closing] …
  final num? balance;

  /// … and its side: 'Dr' or 'Cr'.
  final String? dc;

  factory LedgerRow.fromJson(Map<String, dynamic> j) => LedgerRow(
        name: (j['name'] ?? '').toString(),
        parent: _sn(j['parent']),
        bucket: _sn(j['bucket']),
        opening: _toNum(j['opening']),
        debit: _toNum(j['debit']),
        credit: _toNum(j['credit']),
        closing: _toNum(j['closing']),
        balance: _toNum(j['balance']),
        dc: _sn(j['dc']),
      );
}

/// One ledger's statement for a period: who the ledger is, the opening/closing
/// pair Tally prints, and the vouchers that moved it.
class LedgerStatement {
  const LedgerStatement({
    required this.name,
    this.parent,
    this.gstin,
    this.state,
    this.address,
    this.contact,
    this.email,
    this.bankName,
    this.bankAccNo,
    this.ifsc,
    this.openingAmount,
    this.openingDc,
    this.closingAmount,
    this.closingDc,
    this.debit,
    this.credit,
    this.voucherTypes = const [],
    this.rows = const [],
    this.total = 0,
    this.page = 1,
    this.perPage = 20,
  });

  final String name;
  final String? parent;
  final String? gstin;
  final String? state;
  final String? address;
  final String? contact;
  final String? email;
  final String? bankName;
  final String? bankAccNo;
  final String? ifsc;

  final num? openingAmount;
  final String? openingDc;
  final num? closingAmount;
  final String? closingDc;
  final num? debit;
  final num? credit;

  /// The voucher types present in the period — drives the filter chips.
  final List<String> voucherTypes;

  final List<LedgerEntry> rows;
  final int total;
  final int page;
  final int perPage;

  bool get hasMore => page * perPage < total;

  factory LedgerStatement.fromJson(Map<String, dynamic> j) {
    final ledger = (j['ledger'] is Map)
        ? (j['ledger'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final balance = (j['balance'] is Map)
        ? (j['balance'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final meta = (j['meta'] is Map)
        ? (j['meta'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};

    return LedgerStatement(
      name: (ledger['name'] ?? '').toString(),
      parent: _sn(ledger['parent']),
      gstin: _sn(ledger['gstin']),
      state: _sn(ledger['state']),
      address: _sn(ledger['address']),
      contact: _sn(ledger['contact']),
      email: _sn(ledger['email']),
      bankName: _sn(ledger['bank_name']),
      bankAccNo: _sn(ledger['bank_acc_no']),
      ifsc: _sn(ledger['ifsc']),
      openingAmount: _toNum(balance['opening_amount']),
      openingDc: _sn(balance['opening_dc']),
      closingAmount: _toNum(balance['closing_amount']),
      closingDc: _sn(balance['closing_dc']),
      debit: _toNum(balance['debit']),
      credit: _toNum(balance['credit']),
      voucherTypes: (j['voucher_types'] is List)
          ? (j['voucher_types'] as List).map((e) => e.toString()).toList()
          : const [],
      rows: (j['data'] is List)
          ? (j['data'] as List)
              .whereType<Map>()
              .map((m) => LedgerEntry.fromJson(m.cast<String, dynamic>()))
              .toList(growable: false)
          : const [],
      total: _toInt(meta['total']) ?? 0,
      page: _toInt(meta['page']) ?? 1,
      perPage: _toInt(meta['per_page']) ?? 20,
    );
  }
}

/// One voucher line on a ledger statement.
class LedgerEntry {
  const LedgerEntry({
    this.voucherGuid,
    this.voucherNo,
    this.voucherType,
    this.voucherDate,
    this.counterLedger,
    this.referenceNo,
    this.amount,
    this.dc,
  });

  final String? voucherGuid;
  final String? voucherNo;
  final String? voucherType;
  final String? voucherDate;

  /// The OTHER side of the voucher — who this ledger moved money with.
  /// Without it a statement is just a list of amounts.
  final String? counterLedger;
  final String? referenceNo;

  /// Magnitude; [dc] carries the side.
  final num? amount;
  final String? dc;

  bool get isDebit => dc == 'Dr';

  factory LedgerEntry.fromJson(Map<String, dynamic> j) => LedgerEntry(
        voucherGuid: _sn(j['voucher_guid']),
        voucherNo: _sn(j['voucher_no']),
        voucherType: _sn(j['voucher_type']),
        voucherDate: _sn(j['voucher_date']),
        counterLedger: _sn(j['counter_ledger']),
        referenceNo: _sn(j['reference_no']),
        amount: _toNum(j['amount']),
        dc: _sn(j['dc']),
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
