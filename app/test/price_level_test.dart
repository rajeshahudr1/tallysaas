import 'package:flutter_test/flutter_test.dart';
import 'package:tallysaas_app/features/transactions/price_level.dart';

/// Price levels decide what money goes on a voucher line, so the band lookup
/// is worth pinning. The same rules are tested on the web side
/// (web/tests/voucherExtras.test.js) — if one moves, the two apps disagree
/// about the price of the same order.
void main() {
  PriceCard card(List<PriceSlab> slabs) => PriceCard({'shoe a': slabs});

  test('picks the band the quantity falls in', () {
    final c = card(const [
      PriceSlab(fromQty: 1, toQty: 99, rate: 100),
      PriceSlab(fromQty: 100, toQty: null, rate: 90),
    ]);
    expect(c.rateFor('SHOE A', 5), 100);
    expect(c.rateFor('SHOE A', 99), 100);
    // 100 is the first quantity that earns the bulk rate — an off-by-one here
    // overcharges the one order that just qualified.
    expect(c.rateFor('SHOE A', 100), 90);
    expect(c.rateFor('SHOE A', 5000), 90);
  });

  test('a null bound is open-ended on that side', () {
    final c = card(const [PriceSlab(fromQty: null, toQty: 10, rate: 50)]);
    expect(c.rateFor('SHOE A', 0), 50);
    expect(c.rateFor('SHOE A', 10), 50);
  });

  test('falls back to the first band when the quantity matches none', () {
    // A level with one un-banded rate must still apply before any quantity is
    // typed — the common case.
    final c = card(const [PriceSlab(fromQty: 5, toQty: 10, rate: 42)]);
    expect(c.rateFor('SHOE A', 1), 42);
  });

  test('the lookup ignores case', () {
    final c = card(const [PriceSlab(rate: 7)]);
    expect(c.rateFor('Shoe A', 1), 7);
    expect(c.rateFor('SHOE A', 1), 7);
  });

  test('says nothing about an item the level does not cover', () {
    // Null is "no opinion", which the form reads as "keep the item's own
    // price" — not as a rate of zero.
    final c = card(const [PriceSlab(rate: 7)]);
    expect(c.rateFor('SOMETHING ELSE', 1), isNull);
    expect(PriceCard.empty.rateFor('SHOE A', 1), isNull);
  });

  test('an empty band list is no opinion, not a zero rate', () {
    expect(card(const []).rateFor('SHOE A', 1), isNull);
  });

  test('drCr prints the side rather than a minus sign', () {
    // "₹-23,003.00" reads like a bug; "₹23,003.00 Dr" reads like money owed.
    expect(drCr(23003), contains('Dr'));
    expect(drCr(-23003), contains('Cr'));
    expect(drCr(23003), isNot(contains('-')));
    expect(drCr(0), isNot(contains('Dr')));
  });
}
