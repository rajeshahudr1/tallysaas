import 'package:flutter_test/flutter_test.dart';
import 'package:tallysaas_app/data/models/customer.dart';
import 'package:tallysaas_app/data/models/paged.dart';
import 'package:tallysaas_app/data/models/product.dart';

/// The fields the Parties tabs and the Items "Amount" column depend on. Each
/// of these is a place where "absent" and "zero" mean different things, and
/// conflating them puts a wrong number in front of the user.
void main() {
  group('Customer.isFavourite', () {
    test('reads the flag in the shapes the API and a form may send it', () {
      // Postgres sends a real bool; a form post sends a string; some drivers
      // send 1/0.
      expect(Customer.fromJson({'id': 1, 'name': 'A', 'is_favourite': true}).isFavourite, isTrue);
      expect(Customer.fromJson({'id': 1, 'name': 'A', 'is_favourite': 1}).isFavourite, isTrue);
      expect(Customer.fromJson({'id': 1, 'name': 'A', 'is_favourite': 'true'}).isFavourite, isTrue);
    });

    test('defaults to not starred, including when the key is absent', () {
      expect(Customer.fromJson({'id': 1, 'name': 'A'}).isFavourite, isFalse);
      expect(Customer.fromJson({'id': 1, 'name': 'A', 'is_favourite': false}).isFavourite, isFalse);
      expect(Customer.fromJson({'id': 1, 'name': 'A', 'is_favourite': null}).isFavourite, isFalse);
    });

    test('copyWith flips the star and keeps everything else', () {
      final c = Customer.fromJson({
        'id': 7, 'name': 'ACME', 'mobile': '99', 'credit_limit': 5000,
        'closing_balance': 1234, 'is_favourite': false,
      });
      final starred = c.copyWith(isFavourite: true);
      expect(starred.isFavourite, isTrue);
      expect(starred.id, 7);
      expect(starred.name, 'ACME');
      expect(starred.mobile, '99');
      expect(starred.creditLimit, 5000);
      expect(starred.closingBalance, 1234);
      // The original is untouched — the list swaps in a new row.
      expect(c.isFavourite, isFalse);
    });
  });

  group('Product stock value', () {
    test('carries the amount the stock on hand is worth', () {
      final p = Product.fromJson({
        'id': 1, 'name': 'SHOE', 'closing_stock': 45,
        'avg_purchase_rate': 117.28, 'stock_value': 5277.6,
      });
      expect(p.stockValue, 5277.6);
    });

    test('is null, not zero, for an item never purchased', () {
      // 0 would read as worthless stock; null reads as unvalued stock, which
      // is what it is.
      final p = Product.fromJson({'id': 1, 'name': 'SHOE', 'closing_stock': 3});
      expect(p.stockValue, isNull);
      expect(p.avgPurchaseRate, isNull);
    });
  });

  group('OptionItem', () {
    test('stock comes from closing_stock, not opening_stock', () {
      // opening_stock is where the item STARTED and is routinely 0 on a synced
      // item — reading it made every voucher line report "In stock: 0".
      final o = OptionItem.fromJson({
        'id': 1, 'name': 'SHOE', 'opening_stock': 0, 'closing_stock': 60,
      });
      expect(o.stock, 60);
    });

    test('falls back to opening_stock only when closing is absent', () {
      final o = OptionItem.fromJson({'id': 1, 'name': 'SHOE', 'opening_stock': 12});
      expect(o.stock, 12);
    });

    test('a party option carries its closing balance, or null', () {
      expect(OptionItem.fromJson({'id': 1, 'name': 'A', 'closing_balance': -5000}).balance, -5000);
      // No synced ledger is deliberately different from a balance of zero.
      expect(OptionItem.fromJson({'id': 1, 'name': 'A'}).balance, isNull);
    });
  });
}
