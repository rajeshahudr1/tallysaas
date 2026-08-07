import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/user.dart';

AppUser _user(List<String> perms, {bool salesman = false, bool customer = false}) => AppUser(
      id: 1,
      name: 'T',
      email: 't@t.com',
      role: 'R',
      roleSlug: 'r',
      permissions: perms,
      isSalesman: salesman,
      isCustomerUser: customer,
    );

void main() {
  test('every entry carries a permission module slug', () {
    for (final g in kAppMenu) {
      for (final e in g.items) {
        expect(e.module, isNotEmpty, reason: '${e.key} has no module');
      }
    }
  });

  test('entry keys are unique', () {
    final keys = [for (final g in kAppMenu) for (final e in g.items) e.key];
    expect(keys.toSet().length, keys.length);
  });

  test('a super admin sees every group except Create Vouchers', () {
    expect(visibleMenu(_user(['*'])).length, kAppMenu.length - 1);
  });

  test('a role sees only its granted modules, and empty groups drop out', () {
    final menu = visibleMenu(_user(['customers.view']));
    expect(menu.length, 1);
    expect(menu.single.label, 'Customers');
    expect(menu.single.items.single.key, 'customers');
  });

  test('adminOnly entries are hidden from a view-only role', () {
    final menu = visibleMenu(_user(['tally-sync.view']));
    expect(menu, isEmpty);
  });

  test('salesmanOnly entries show only for a linked salesman', () {
    final staffMenu = visibleMenu(_user(['field-sales.view']));
    final staffKeys = [for (final g in staffMenu) for (final e in g.items) e.key];
    expect(staffKeys, isNot(contains('my-field')));

    final menu = visibleMenu(_user(['field-sales.view'], salesman: true));
    final keys = [for (final g in menu) for (final e in g.items) e.key];
    expect(keys, contains('my-field'));
  });

  test('approverOnly entries need the edit action and a non-salesman', () {
    final approver = visibleMenu(_user(['sales-invoices.view', 'sales-invoices.edit']));
    final approverKeys = [for (final g in approver) for (final e in g.items) e.key];
    expect(approverKeys, contains('approvals'));

    final salesman = visibleMenu(
      _user(['sales-invoices.view', 'sales-invoices.edit'], salesman: true),
    );
    final salesmanKeys = [for (final g in salesman) for (final e in g.items) e.key];
    expect(salesmanKeys, isNot(contains('approvals')));
  });

  test('create entries are the Create Vouchers group', () {
    final entries = visibleCreateEntries(_user(['*']));
    expect(entries.every((e) => e.create), isTrue);
    expect(entries.map((e) => e.key), contains('new-quotation'));
  });

  test('create entries are filtered by the create action', () {
    final entries = visibleCreateEntries(_user(['sales-invoices.create']));
    expect(entries.map((e) => e.key), ['new-sales-inv']);
  });

  test('menuGroup finds a group by label', () {
    expect(menuGroup('Sales')?.label, 'Sales');
    expect(menuGroup('Nope'), isNull);
  });
}
