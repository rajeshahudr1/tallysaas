import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/quotation.dart';

void main() {
  test('parses a list row, coercing pg string numerics', () {
    final q = Quotation.fromJson({
      'id': '7',
      'quotation_no': 'QT-0007',
      'customer_id': '3',
      'customer': 'Acme Traders',
      'quotation_date': '2026-08-01',
      'valid_till': '2026-08-15',
      'total': '11800.00',
      'quote_status': 'open',
      'status': 'draft_cloud',
    });

    expect(q.id, 7);
    expect(q.quotationNo, 'QT-0007');
    expect(q.customerId, 3);
    expect(q.total, 11800.00);
    expect(q.quoteStatus, 'open');
    expect(q.isConverted, isFalse);
    expect(q.items, isEmpty);
  });

  test('parses the detail payload with items', () {
    final q = Quotation.fromJson({
      'id': 7,
      'quotation_no': 'QT-0007',
      'converted_invoice_id': '42',
      'items': [
        {
          'id': 1,
          'description': 'Widget',
          'quantity': '2.000',
          'rate': '5000.00',
          'gst_rate': '18.00',
          'amount': '11800.00',
          'tax_inclusive': false,
        },
      ],
    });

    expect(q.items.length, 1);
    expect(q.items.single.quantity, 2);
    expect(q.items.single.amount, 11800.00);
    expect(q.isConverted, isTrue);
  });

  test('an item writes only the inputs the API accepts', () {
    const it = QuotationItem(
      productId: 4,
      description: 'Widget',
      quantity: 2,
      rate: 5000,
      gstRate: 18,
      // Server-computed columns must never be sent back.
      taxable: 10000,
      gstAmount: 1800,
      amount: 11800,
    );

    final body = it.toJson();
    expect(body['product_id'], 4);
    expect(body['quantity'], 2);
    expect(body['rate'], 5000);
    expect(body.containsKey('taxable'), isFalse);
    expect(body.containsKey('gst_amount'), isFalse);
    expect(body.containsKey('amount'), isFalse);
  });

  test('quoteStatusLabel covers the deal lifecycle', () {
    expect(quoteStatusLabel('open'), 'Open');
    expect(quoteStatusLabel('accepted'), 'Accepted');
    expect(quoteStatusLabel('rejected'), 'Rejected');
    expect(quoteStatusLabel('expired'), 'Expired');
    expect(quoteStatusLabel(null), 'Open');
  });

  test('the menu points quotations at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) =>
        entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('quotations'), '/quotations');
    expect(routeOf('new-quotation'), '/quotations/add');
    expect(routeOf('my-quotations'), '/my-quotations');
  });
}
