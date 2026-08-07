import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/core/auth/session.dart';
import 'package:tallysaas_app/data/models/user.dart';
import 'package:tallysaas_app/features/menu/group_hub_screen.dart';

void main() {
  testWidgets('renders the named group filtered by permissions', (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['sales-invoices.view', 'receipts.view'],
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        sessionProvider.overrideWith((ref) => SessionController()..setSignedIn(user)),
      ],
      child: const MaterialApp(home: GroupHubScreen(groupLabel: 'Sales')),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Sales'), findsWidgets);
    expect(find.text('Receipt'), findsOneWidget);
    expect(find.text('Recurring Invoices'), findsNothing);
  });

  testWidgets('shows an empty note when the role has nothing in the group',
      (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['customers.view'],
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        sessionProvider.overrideWith((ref) => SessionController()..setSignedIn(user)),
      ],
      child: const MaterialApp(home: GroupHubScreen(groupLabel: 'Purchase')),
    ));
    await tester.pumpAndSettle();

    expect(find.text('No Purchase modules for your role.'), findsOneWidget);
  });
}
