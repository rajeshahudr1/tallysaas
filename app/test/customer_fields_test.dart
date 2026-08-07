import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/data/models/customer.dart';

void main() {
  test('parses the Tally party fields the web form has always carried', () {
    final c = Customer.fromJson({
      'id': '3',
      'name': 'Acme Traders',
      'country': 'India',
      'state': 'Gujarat',
      'city': 'Surat',
      'pincode': '395006',
      'gst_registration_type': 'Regular',
      'ledger_group': 'Sundry Debtors',
      'opening_balance': '1500.00',
      'opening_balance_type': 'Dr',
    });

    expect(c.country, 'India');
    expect(c.state, 'Gujarat');
    expect(c.city, 'Surat');
    expect(c.pincode, '395006');
    expect(c.gstRegistrationType, 'Regular');
    expect(c.ledgerGroup, 'Sundry Debtors');
    expect(c.openingBalance, 1500.00);
    // The side is a separate field — the amount alone does not say which way
    // the balance runs.
    expect(c.openingBalanceType, 'Dr');
  });

  test('missing party fields stay null rather than becoming empty strings', () {
    final c = Customer.fromJson({'id': 4, 'name': 'Beta Stores', 'state': '  '});

    expect(c.country, isNull);
    expect(c.state, isNull);
    expect(c.gstRegistrationType, isNull);
    expect(c.openingBalanceType, isNull);
  });
}
