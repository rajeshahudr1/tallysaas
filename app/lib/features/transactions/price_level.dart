import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';

/// Price levels — Tally's per-tier rate cards ("Wholesale", "Retail"), mirrored
/// from the web voucher forms.
///
/// What a price level DOES: it decides which rate fills the Rate column when an
/// item is picked, instead of the item's own standard price. Tally stores a
/// card per level, optionally banded by quantity ("1–99 at 100, 100+ at 90"),
/// so the lookup is item → slabs → the slab matching this line's quantity.
///
/// The whole card is fetched once per level rather than once per item, so
/// choosing an item never waits on the network.

/// One band of a level's rate for one item.
class PriceSlab {
  const PriceSlab({this.fromQty, this.toQty, this.rate, this.discount});
  final double? fromQty;
  final double? toQty;
  final double? rate;
  final double? discount;

  factory PriceSlab.fromJson(Map<String, dynamic> j) => PriceSlab(
        fromQty: _d(j['from_qty']),
        toQty: _d(j['to_qty']),
        rate: _d(j['rate']),
        discount: _d(j['discount']),
      );
}

/// A whole level's card: lower-cased item name → its bands, in quantity order.
class PriceCard {
  const PriceCard(this._byItem);
  final Map<String, List<PriceSlab>> _byItem;

  static const PriceCard empty = PriceCard({});

  /// Which band applies at this quantity.
  ///
  /// A null bound is open-ended on that side. Falls back to the FIRST band when
  /// the quantity matches none — a level with a single un-banded rate must
  /// still apply before any quantity is typed, which is the common case.
  /// Returns null only when the level says nothing about this item, which the
  /// caller reads as "no opinion" and leaves the item's own price alone.
  PriceSlab? slabFor(String itemName, double qty) {
    final slabs = _byItem[itemName.toLowerCase()];
    if (slabs == null || slabs.isEmpty) return null;
    for (final s in slabs) {
      final from = s.fromQty ?? 0;
      final to = s.toQty ?? double.infinity;
      if (qty >= from && qty <= to) return s;
    }
    return slabs.first;
  }

  /// The rate this level sets for an item at a quantity, or null for no opinion.
  double? rateFor(String itemName, double qty) => slabFor(itemName, qty)?.rate;
}

/// The levels this company actually uses. Empty for a company with none, in
/// which case the picker is not shown at all rather than shown empty.
final priceLevelsProvider = FutureProvider.autoDispose<List<String>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final data = await api.get('/tally/price-levels');
  final rows = (data is Map && data['data'] is List) ? data['data'] as List : const [];
  return rows
      .map((r) => (r is Map ? (r['name'] ?? '').toString() : '').trim())
      .where((n) => n.isNotEmpty)
      .toList();
});

/// One level's whole rate card, keyed by the level name.
final priceCardProvider =
    FutureProvider.autoDispose.family<PriceCard, String>((ref, level) async {
  if (level.isEmpty) return PriceCard.empty;
  final api = ref.watch(apiClientProvider);
  final data = await api.get('/tally/price-list', query: {'level': level});
  final rows = (data is Map && data['data'] is List) ? data['data'] as List : const [];
  final byItem = <String, List<PriceSlab>>{};
  for (final r in rows) {
    if (r is! Map) continue;
    final key = (r['stock_item'] ?? '').toString().trim().toLowerCase();
    if (key.isEmpty) continue;
    byItem.putIfAbsent(key, () => <PriceSlab>[])
        .add(PriceSlab.fromJson(Map<String, dynamic>.from(r)));
  }
  return PriceCard(byItem);
});

/// The Price Level dropdown. Renders NOTHING when the company uses no price
/// levels — an empty picker is a dead control that says "you can choose a rate
/// card" to someone who has none.
class PriceLevelPicker extends ConsumerWidget {
  const PriceLevelPicker({super.key, required this.value, required this.onChanged});
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final levels = ref.watch(priceLevelsProvider);
    return levels.maybeWhen(
      data: (list) {
        if (list.isEmpty) return const SizedBox.shrink();
        final theme = Theme.of(context);
        return Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                child: Text('Price Level', style: theme.textTheme.titleSmall),
              ),
              DropdownButtonFormField<String>(
                value: (value != null && list.contains(value)) ? value : null,
                isExpanded: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.sell_outlined, size: 18)),
                hint: const Text('Standard rate'),
                items: [
                  const DropdownMenuItem<String>(value: null, child: Text('Standard rate')),
                  ...list.map((l) => DropdownMenuItem<String>(value: l, child: Text(l))),
                ],
                onChanged: onChanged,
              ),
            ],
          ),
        );
      },
      // While the levels are loading, or if the lookup failed, show nothing
      // rather than an empty picker that might still populate.
      orElse: () => const SizedBox.shrink(),
    );
  }
}

/// The chosen party's standing, under the picker. Raising a voucher for someone
/// already deep in arrears is a decision worth making knowingly.
class PartyBalanceLine extends StatelessWidget {
  const PartyBalanceLine({super.key, required this.balance});

  /// Null means the party has no synced ledger — deliberately different from a
  /// balance of zero, and shown as nothing rather than a fake ₹0.00.
  final double? balance;

  @override
  Widget build(BuildContext context) {
    if (balance == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: AppSpacing.sm8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text('Closing Balance: ${drCr(balance!)}',
            style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
      ),
    );
  }
}

/// A ledger balance printed the way Tally prints it: magnitude plus the side it
/// sits on. "₹-23,003.00" reads like a bug; "₹23,003.00 Dr" reads like money
/// the customer owes.
String drCr(double v) {
  if (v == 0) return Fmt.inr(0);
  return '${Fmt.inr(v.abs())} ${v > 0 ? 'Dr' : 'Cr'}';
}

double? _d(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  return double.tryParse(v.toString());
}
