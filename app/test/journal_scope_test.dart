import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/repositories/journal_repository.dart';

void main() {
  test('each scope carries its own path, permission slug and titles', () {
    expect(JournalScope.journals.path, '/journals');
    expect(JournalScope.journals.module, 'journals');
    expect(JournalScope.journals.singular, 'Journal');

    expect(JournalScope.contra.path, '/contra');
    expect(JournalScope.contra.module, 'contra');
    expect(JournalScope.contra.title, 'Contra');
  });

  test('the menu points contra at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('contra'), '/contra');
    expect(routeOf('new-contra'), '/contra/add');
    // Journals kept their own routes through the same shared screens.
    expect(routeOf('journals'), '/journals');
  });
}
