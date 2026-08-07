import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/core/auth/session.dart';
import 'package:tallysaas_app/data/models/user.dart';
import 'package:tallysaas_app/features/menu/more_menu_screen.dart';

Widget _app(AppUser user) => ProviderScope(
      overrides: [
        sessionProvider.overrideWith((ref) => SessionController()..setSignedIn(user)),
      ],
      child: const MaterialApp(home: MoreMenuScreen()),
    );

void main() {
  testWidgets('shows only the groups the role may see', (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['customers.view'],
    );
    await tester.pumpWidget(_app(user));
    await tester.pumpAndSettle();

    expect(find.text('Customers'), findsWidgets);
    expect(find.text('Tally Sync'), findsNothing);
  });

  testWidgets('an unbuilt module renders a Soon tag', (tester) async {
    // GPS Tracking is the one menu item with no app screen — the API exposes it
    // only under /super-admin. It is adminOnly, hence the edit grant.
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['gps-tracking.edit'],
    );
    await tester.pumpWidget(_app(user));
    await tester.pumpAndSettle();

    expect(find.text('GPS Tracking'), findsOneWidget);
    expect(find.text('Soon'), findsOneWidget);
  });

  testWidgets('a built module renders a chevron instead of Soon', (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['gst-search.view'],
    );
    await tester.pumpWidget(_app(user));
    await tester.pumpAndSettle();

    expect(find.text('GST Search'), findsOneWidget);
    expect(find.text('Soon'), findsNothing);
  });

  testWidgets('groups sit under the web MAIN / MANAGE / SETTINGS sections',
      (tester) async {
    const user = AppUser(
      id: 1, name: 'T', email: 't@t.com', role: 'R', roleSlug: 'r',
      permissions: ['*'],
    );
    await tester.pumpWidget(_app(user));
    await tester.pumpAndSettle();

    expect(find.text('MAIN'), findsOneWidget);

    // MANAGE sits below the fold — scroll the list until it builds.
    await tester.scrollUntilVisible(find.text('MANAGE'), 400,
        scrollable: find.byType(Scrollable).first);
    expect(find.text('MANAGE'), findsOneWidget);
  });
}
