import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/core/constants.dart';
import 'package:tallysaas_app/data/models/payment_request.dart';

void main() {
  test('parses a payment request row', () {
    final r = PaymentRequest.fromJson({
      'id': '9',
      'invoice_id': '31',
      'invoice_no': 'INV-0031',
      'customer': 'Acme Traders',
      'amount': '1180.00',
      'token': '4.abc123',
      'status': 'pending',
      'note': 'Due today',
    });

    expect(r.id, 9);
    expect(r.invoiceNo, 'INV-0031');
    expect(r.amount, 1180.00);
    expect(r.isPending, isTrue);
  });

  test('an outstanding invoice carries what is still due', () {
    final inv = OutstandingInvoice.fromJson({
      'id': 31,
      'invoice_no': 'INV-0031',
      'customer': 'Acme Traders',
      'total': '1180.00',
      'paid': '180.00',
      'outstanding': '1000.00',
    });

    expect(inv.total, 1180.00);
    expect(inv.paid, 180.00);
    expect(inv.outstanding, 1000.00);
  });

  test('settings round-trip through the API shape', () {
    const s = CollectPaymentSettings(
      enabled: true,
      upiVpa: 'shop@bank',
      payeeName: 'Shop',
    );
    final json = s.toJson();
    expect(json['enabled'], isTrue);
    expect(json['upi_vpa'], 'shop@bank');

    final back = CollectPaymentSettings.fromJson(json);
    expect(back.enabled, isTrue);
    expect(back.payeeName, 'Shop');
  });

  test('payLink stays null when this build has no web address', () {
    // The default build has no WEB_BASE, so a link cannot be guessed — the UI
    // falls back to sharing the raw token.
    expect(AppConfig.webBase, isEmpty);
    expect(AppConfig.payLink('4.abc123'), isNull);
    expect(AppConfig.payLink(null), isNull);
  });

  test('the menu points collect payments at the built screen', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    final route = entries.firstWhere((e) => e.key == 'collect-payments').route;
    expect(route, '/collect-payments');
  });
}
