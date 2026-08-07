import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/core/auth/session.dart';
import 'package:tallysaas_app/data/models/user.dart';
import 'package:tallysaas_app/features/menu/create_voucher_sheet.dart';

Widget _app(AppUser user) => ProviderScope(
      overrides: [
        sessionProvider.overrideWith((ref) => SessionController()..setSignedIn(user)),
      ],
      child: MaterialApp(
        home: Consumer(
          builder: (context, ref, _) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showCreateVoucherSheet(context, ref),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

void main() {
  testWidgets('lists only the voucher types the role can create', (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['sales-invoices.create', 'receipts.create'],
    );
    await tester.pumpWidget(_app(user));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Sales Invoice'), findsOneWidget);
    expect(find.text('Receipt'), findsOneWidget);
    expect(find.text('Journal'), findsNothing);
  });

  testWidgets('says so when the role cannot create anything', (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['sales-invoices.view'],
    );
    await tester.pumpWidget(_app(user));

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Your role cannot create vouchers.'), findsOneWidget);
  });
}
