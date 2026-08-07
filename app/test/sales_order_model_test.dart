import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/sales_order.dart';

void main() {
  test('parses a list row, coercing pg string numerics', () {
    final so = SalesOrder.fromJson({
      'id': '12',
      'order_no': 'SO-0012',
      'customer': 'Acme Traders',
      'order_date': '2026-08-01',
      'due_on': '2026-08-20',
      'total': '23600.00',
      'order_status': 'partially_delivered',
      'status': 'pending_tally',
    });

    expect(so.id, 12);
    expect(so.orderNo, 'SO-0012');
    expect(so.dueOn, '2026-08-20');
    expect(so.total, 23600.00);
    expect(so.orderStatus, 'partially_delivered');
    expect(so.isConverted, isFalse);
  });

  test('parses the detail payload with shared voucher items', () {
    final so = SalesOrder.fromJson({
      'id': 12,
      'order_no': 'SO-0012',
      'converted_invoice_id': '99',
      'items': [
        {'description': 'Widget', 'quantity': '3.000', 'rate': '100.00', 'amount': '354.00'},
      ],
    });

    expect(so.items.single.quantity, 3);
    expect(so.items.single.amount, 354.00);
    expect(so.isConverted, isTrue);
  });

  test('orderStatusLabel covers the delivery lifecycle', () {
    expect(orderStatusLabel('pending'), 'Pending');
    expect(orderStatusLabel('partially_delivered'), 'Partial');
    expect(orderStatusLabel('delivered'), 'Delivered');
    expect(orderStatusLabel('cancelled'), 'Cancelled');
    expect(orderStatusLabel(null), 'Pending');
  });

  test('the menu points sales orders at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('sales-orders'), '/sales-orders');
    expect(routeOf('new-sales-order'), '/sales-orders/add');
  });
}
