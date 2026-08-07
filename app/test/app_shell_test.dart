import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';

void main() {
  test('the shell tabs map to menu groups that exist', () {
    // AppShell hardcodes these labels for its Sales / Purchase branches and the
    // Create sheet; renaming a group in kAppMenu must not silently empty a tab.
    expect(menuGroup('Sales'), isNotNull);
    expect(menuGroup('Purchase'), isNotNull);
    expect(menuGroup('Create Vouchers'), isNotNull);
  });
}
