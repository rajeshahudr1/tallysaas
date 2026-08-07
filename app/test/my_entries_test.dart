import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/features/my_entries/my_vouchers_screen.dart';

void main() {
  test('a my-voucher row parses the API union shape', () {
    final v = MyVoucher.fromJson({
      'kind': 'quotation',
      'label': 'Quotation',
      'id': '7',
      'voucher_no': 'QT-0007',
      'date': '2026-08-01',
      'party': 'Acme Traders',
      'amount': '1180.00',
      'status': 'open',
    });

    expect(v.id, 7);
    expect(v.kind, 'quotation');
    expect(v.label, 'Quotation');
    expect(v.amount, 1180.00);
  });

  test('each kind routes to the screen that owns it', () {
    String? routeFor(String kind) =>
        MyVoucher.fromJson({'kind': kind, 'id': 5}).route;

    expect(routeFor('quotation'), '/quotations/5');
    expect(routeFor('sales_order'), '/sales-orders/5');
    expect(routeFor('purchase_order'), '/purchase-orders/5');
    expect(routeFor('delivery_note'), '/delivery-notes/5');
    expect(routeFor('receipt_note'), '/receipt-notes/5');
    expect(routeFor('journal'), '/journals/5');
    // An unknown kind must NOT guess a route that would 404.
    expect(routeFor('something_new'), isNull);
  });

  test('the My Entries menu points at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('my-vouchers'), '/my-vouchers');
    expect(routeOf('my-einvoices'), '/my-einvoices');
    expect(routeOf('my-eway'), '/my-eway');
    expect(routeOf('my-parties'), '/my-customers');
    expect(routeOf('field-tracking'), '/field-tracking');
    // The API has no per-user product scoping, so this opens plain Products.
    expect(routeOf('my-stock'), '/products');
  });
}
