import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/stock_voucher.dart';

void main() {
  test('a stock journal splits its lines into sources and destinations', () {
    final sj = StockJournal.fromJson({
      'id': '6',
      'voucher_no': 'SJ-0006',
      'journal_date': '2026-08-05',
      'narration': 'Godown transfer',
      'items': [
        {'product_id': '1', 'direction': 'source', 'quantity': '5.000', 'godown': 'Main'},
        {'product_id': '1', 'direction': 'destination', 'quantity': '5.000', 'godown': 'Branch'},
      ],
    });

    expect(sj.id, 6);
    expect(sj.items.length, 2);
    expect(sj.sources.single.godown, 'Main');
    expect(sj.destinations.single.godown, 'Branch');
    expect(sj.sources.single.quantity, 5);
    expect(sj.sources.single.isSource, isTrue);
  });

  test('a stock journal line writes only what the API accepts', () {
    const it = StockJournalItem(
      productId: 3,
      direction: 'destination',
      quantity: 2,
      godown: 'Main',
      productName: 'Widget', // display-only, must not be sent
    );

    final body = it.toJson();
    expect(body['product_id'], 3);
    expect(body['direction'], 'destination');
    expect(body['quantity'], 2);
    expect(body.containsKey('product_name'), isFalse);
  });

  test('a physical-stock LIST row carries a line count, not lines', () {
    final sheet = PhysicalStockSheet.fromJson({
      'voucher_no': 'PS-0002',
      'count_date': '2026-08-04',
      'items': 7,
    });

    expect(sheet.voucherNo, 'PS-0002');
    expect(sheet.itemCount, 7);
    expect(sheet.items, isEmpty);
  });

  test('a physical-stock DETAIL payload carries the counted lines', () {
    final sheet = PhysicalStockSheet.fromJson({
      'voucher_no': 'PS-0002',
      'count_date': '2026-08-04',
      'narration': 'Monthly count',
      'items': [
        {
          'product_id': 4,
          'product_name': 'Widget',
          'product_sku': 'W-1',
          'quantity': '0',
          'godown': 'Main',
        },
      ],
    });

    expect(sheet.narration, 'Monthly count');
    expect(sheet.items.single.productName, 'Widget');
    // A counted zero is meaningful — the shelf was empty.
    expect(sheet.items.single.countedQty, 0);
    expect(sheet.itemCount, isNull);
  });

  test('the menu points both stock vouchers at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('stock-journals'), '/stock-journals');
    expect(routeOf('new-stock-jrnl'), '/stock-journals/add');
    expect(routeOf('physical-stock'), '/physical-stock');
    expect(routeOf('new-phys-stock'), '/physical-stock/add');
  });
}
