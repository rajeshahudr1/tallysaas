import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/portal_user.dart';

void main() {
  test('a customer row reports whether a portal login exists', () {
    final withLogin = CustomerUser.fromJson({
      'id': '4',
      'name': 'Acme Traders',
      'email': 'buy@acme.test',
      'user_id': '17',
    });
    final without = CustomerUser.fromJson({'id': 5, 'name': 'Beta Stores'});

    expect(withLogin.hasLogin, isTrue);
    expect(withLogin.userId, 17);
    expect(without.hasLogin, isFalse);
  });

  test('a catalog entry round-trips the API shape', () {
    final e = CatalogEntry.fromJson({
      'category_id': '3',
      'discount_pct': '5.00',
      'addition_pct': '0',
      'product_ids': ['9', 10],
    });

    expect(e.categoryId, 3);
    expect(e.discountPct, 5.00);
    expect(e.productIds, [9, 10]);

    final json = e.toJson();
    expect(json['category_id'], 3);
    expect(json['product_ids'], [9, 10]);
  });

  test('a website user carries its pricing uplifts and one-time token', () {
    final u = WebsiteUser.fromJson({
      'id': 2,
      'name': 'Shop Website',
      'email': 'api@shop.test',
      'cash_extra_pct': '2.50',
      'online_extra_pct': '0',
      'api_token': 'tok_abc',
      'status': 'Active',
    });

    expect(u.name, 'Shop Website');
    expect(u.cashExtraPct, 2.50);
    expect(u.apiToken, 'tok_abc');
  });

  test('the Portals menu points at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('customer-users'), '/customer-users');
    expect(routeOf('website-users'), '/website-users');
  });
}
