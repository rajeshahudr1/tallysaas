import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/data/models/paged.dart';
import 'package:tallysaas_app/features/transactions/invoice_form_parts.dart';

void main() {
  test('a product option exposes its HSN and unit', () {
    final o = OptionItem.fromJson({
      'id': 4,
      'name': 'Widget',
      'hsn_code': '8481',
      'unit': 'Nos',
      'sales_price': '250.00',
      'gst_rate': '18',
    });

    expect(o.hsn, '8481');
    expect(o.unit, 'Nos');
    expect(o.rate, 250.00);
  });

  test('a line sends the HSN and unit it was billed under', () {
    final row = LineRow()
      ..productId = 4
      ..hsn = '8481'
      ..unit = 'Nos';
    row.qty.text = '2';
    row.rate.text = '250';
    row.gst.text = '18';

    final body = row.toBody()!;
    expect(body['product_id'], 4);
    expect(body['hsn'], '8481');
    expect(body['unit'], 'Nos');
    expect(body['quantity'], 2);
  });

  test('a line without HSN or unit omits them rather than sending blanks', () {
    final row = LineRow()..productId = 4;
    row.qty.text = '1';
    row.rate.text = '100';

    final body = row.toBody()!;
    expect(body.containsKey('hsn'), isFalse);
    expect(body.containsKey('unit'), isFalse);
  });

  test('an incomplete line is skipped', () {
    final row = LineRow();
    row.qty.text = '0';
    expect(row.toBody(), isNull);
  });
}
