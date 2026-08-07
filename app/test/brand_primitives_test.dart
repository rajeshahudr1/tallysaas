import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/shared/widgets/brand_primitives.dart';

void main() {
  testWidgets('GradientButton shows its label and fires onPressed', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: GradientButton(label: 'Create Voucher', onPressed: () => taps++),
      ),
    ));
    expect(find.text('Create Voucher'), findsOneWidget);
    await tester.tap(find.text('Create Voucher'));
    expect(taps, 1);
  });

  testWidgets('GradientHeader shows title, subtitle and action', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: GradientHeader(
          title: 'Create Quotation Voucher',
          subtitle: 'Fill in the details to create a new quotation',
          action: Text('View'),
        ),
      ),
    ));
    expect(find.text('Create Quotation Voucher'), findsOneWidget);
    expect(find.text('Fill in the details to create a new quotation'), findsOneWidget);
    expect(find.text('View'), findsOneWidget);
  });
}
