import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/purchase_order.dart';

void main() {
  test('parses a list row keyed on the supplier, not the customer', () {
    final po = PurchaseOrder.fromJson({
      'id': '5',
      'order_no': 'PO-0005',
      'supplier_id': '8',
      'supplier': 'Metro Supplies',
      'order_date': '2026-08-02',
      'due_on': '2026-08-18',
      'total': '9440.00',
      'order_status': 'pending',
    });

    expect(po.id, 5);
    expect(po.orderNo, 'PO-0005');
    expect(po.supplierId, 8);
    expect(po.supplier, 'Metro Supplies');
    expect(po.total, 9440.00);
    expect(po.isConverted, isFalse);
  });

  test('parses the detail payload with shared voucher items', () {
    final po = PurchaseOrder.fromJson({
      'id': 5,
      'order_no': 'PO-0005',
      'converted_invoice_id': '77',
      'items': [
        {'description': 'Bolts', 'quantity': '10.000', 'rate': '20.00', 'amount': '236.00'},
      ],
    });

    expect(po.items.single.quantity, 10);
    expect(po.isConverted, isTrue);
  });

  test('shares the delivery-status labels with sales orders', () {
    expect(orderStatusLabel('partially_delivered'), 'Partial');
    expect(orderStatusLabel(null), 'Pending');
  });

  test('the menu points purchase orders at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('purch-orders'), '/purchase-orders');
    expect(routeOf('new-po'), '/purchase-orders/add');
  });
}
