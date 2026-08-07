import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/goods_note.dart';

void main() {
  test('each kind carries its own path, party and column names', () {
    expect(GoodsNoteKind.delivery.path, '/delivery-notes');
    expect(GoodsNoteKind.delivery.partyKey, 'customer_id');
    expect(GoodsNoteKind.delivery.movementDateKey, 'dispatch_date');
    expect(GoodsNoteKind.delivery.statusQueryKey, 'delivery_status');
    expect(GoodsNoteKind.delivery.orderKey, 'sales_order_id');
    expect(GoodsNoteKind.delivery.invoicePath, '/sales-invoices');

    expect(GoodsNoteKind.receipt.path, '/receipt-notes');
    expect(GoodsNoteKind.receipt.partyKey, 'supplier_id');
    expect(GoodsNoteKind.receipt.movementDateKey, 'received_date');
    expect(GoodsNoteKind.receipt.statusQueryKey, 'receipt_status');
    expect(GoodsNoteKind.receipt.orderKey, 'purchase_order_id');
    expect(GoodsNoteKind.receipt.invoicePath, '/purchase-invoices');
  });

  test('a delivery-note row reads the customer side', () {
    final n = GoodsNote.fromJson({
      'id': '3',
      'note_no': 'DN-0003',
      'customer_id': '7',
      'customer': 'Acme Traders',
      'note_date': '2026-08-03',
      'dispatch_date': '2026-08-04',
      'sales_order_id': '12',
      'delivery_status': 'pending',
      'total': '1180.00',
    }, GoodsNoteKind.delivery);

    expect(n.partyId, 7);
    expect(n.party, 'Acme Traders');
    expect(n.movementDate, '2026-08-04');
    expect(n.orderId, 12);
    expect(n.noteStatus, 'pending');
    expect(n.total, 1180.00);
  });

  test('a receipt-note row reads the supplier side', () {
    final n = GoodsNote.fromJson({
      'id': 4,
      'note_no': 'RN-0004',
      'supplier_id': 9,
      'supplier': 'Metro Supplies',
      'received_date': '2026-08-06',
      'purchase_order_id': 21,
      'receipt_status': 'invoiced',
      'converted_invoice_id': '55',
      'items': [
        {'description': 'Bolts', 'quantity': '5.000', 'amount': '590.00'},
      ],
    }, GoodsNoteKind.receipt);

    expect(n.partyId, 9);
    expect(n.party, 'Metro Supplies');
    expect(n.movementDate, '2026-08-06');
    expect(n.orderId, 21);
    expect(n.isConverted, isTrue);
    expect(n.items.single.quantity, 5);
  });

  test('goodsNoteStatusLabel covers the note lifecycle', () {
    expect(goodsNoteStatusLabel('pending'), 'Pending');
    expect(goodsNoteStatusLabel('invoiced'), 'Invoiced');
    expect(goodsNoteStatusLabel('cancelled'), 'Cancelled');
    expect(goodsNoteStatusLabel(null), 'Pending');
  });

  test('the menu points both note kinds at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('dely-notes'), '/delivery-notes');
    expect(routeOf('new-dely-note'), '/delivery-notes/add');
    expect(routeOf('recpt-notes'), '/receipt-notes');
    expect(routeOf('new-recpt-note'), '/receipt-notes/add');
  });
}
