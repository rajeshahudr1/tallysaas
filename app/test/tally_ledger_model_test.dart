import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/tally_ledger.dart';

void main() {
  test('each bucket maps to its API group, permission slug and route', () {
    expect(LedgerBucket.cash.group, 'cash');
    expect(LedgerBucket.cash.module, 'cash-bank');
    expect(LedgerBucket.bank.module, 'cash-bank');
    expect(LedgerBucket.payables.module, 'payables');
    expect(LedgerBucket.receivables.module, 'receivables');
    expect(LedgerBucket.receivables.title, 'Receivables');
  });

  test('a ledger row keeps the magnitude and its Dr/Cr side apart', () {
    final row = LedgerRow.fromJson({
      'name': 'HDFC Bank',
      'parent': 'Bank Accounts',
      'opening': '1000.00',
      'debit': '5000.00',
      'credit': '2000.00',
      'closing': '4000.00',
      'balance': '4000.00',
      'dc': 'Dr',
    });

    expect(row.name, 'HDFC Bank');
    expect(row.parent, 'Bank Accounts');
    expect(row.closing, 4000.00);
    expect(row.balance, 4000.00);
    expect(row.dc, 'Dr');
  });

  test('a statement parses the ledger, balances, types and rows', () {
    final s = LedgerStatement.fromJson({
      'ledger': {'name': 'HDFC Bank', 'parent': 'Bank Accounts', 'ifsc': 'HDFC0001'},
      'balance': {
        'opening_amount': '1000.00',
        'opening_dc': 'Dr',
        'closing_amount': '4000.00',
        'closing_dc': 'Dr',
        'debit': '5000.00',
        'credit': '2000.00',
      },
      'voucher_types': ['Receipt', 'Payment'],
      'data': [
        {
          'voucher_no': 'RC-1',
          'voucher_type': 'Receipt',
          'voucher_date': '2026-08-01',
          'amount': '500.00',
          'dc': 'Dr',
        },
      ],
      'meta': {'total': 30, 'page': 1, 'per_page': 20},
    });

    expect(s.name, 'HDFC Bank');
    expect(s.ifsc, 'HDFC0001');
    expect(s.openingAmount, 1000.00);
    expect(s.closingDc, 'Dr');
    expect(s.voucherTypes, ['Receipt', 'Payment']);
    expect(s.rows.single.voucherNo, 'RC-1');
    expect(s.rows.single.isDebit, isTrue);
    expect(s.hasMore, isTrue);
  });

  test('the menu points all four buckets at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('cash'), '/cash');
    expect(routeOf('bank-ledgers'), '/bank');
    expect(routeOf('payables'), '/payables');
    expect(routeOf('receivables'), '/receivables');
  });
}
