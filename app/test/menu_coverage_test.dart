import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';

/// The parity ledger: which web menu items the app now has a screen for, and
/// which are deliberately still unbuilt. A new module flips its entry here, so
/// the list can never quietly drift from what actually ships.
void main() {
  final entries = [for (final g in kAppMenu) for (final e in g.items) e];
  String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

  test('every voucher type in the Create sheet has a form', () {
    final createKeys = [
      for (final e in kAppMenu.firstWhere((g) => g.label == 'Create Vouchers').items)
        e.key
    ];
    final missing = [for (final k in createKeys) if (routeOf(k) == null) k];
    expect(missing, isEmpty, reason: 'Create Vouchers without a form: $missing');
  });

  test('the tools and dashboards added in this phase are wired', () {
    expect(routeOf('gst-search'), '/gst-search');
    expect(routeOf('data-backup'), '/data-backup');
    expect(routeOf('einvoice-dash'), '/einvoices/dashboard');
  });

  test('every menu entry now has a screen', () {
    final unbuilt = [
      for (final g in kAppMenu)
        for (final e in g.items)
          if (e.route == null) e.key
    ];
    expect(unbuilt, isEmpty, reason: 'menu entries without a screen: $unbuilt');
  });

  test('GPS Tracking is gated to the platform operator', () {
    // Its endpoint lives under /super-admin, so a company admin has nothing to
    // call — the menu must not offer it to them.
    final gps = entries.firstWhere((e) => e.key == 'gps-settings');
    expect(gps.route, '/gps-settings');
    expect(gps.superOnly, isTrue);
    expect(gps.adminOnly, isFalse);
  });
}
