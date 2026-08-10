import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
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

  testWidgets('a tile with no screen yet renders a Soon tag', (tester) async {
    // Every shipped menu entry now has a screen, so the affordance is proved
    // against a tile built directly — it must keep working for the next module
    // that lands in the menu before its screen does.
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: MenuEntryTile(MenuEntry(
          key: 'not-built-yet',
          label: 'Future Module',
          icon: Icons.science_outlined,
          module: 'future',
        )),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Future Module'), findsOneWidget);
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
