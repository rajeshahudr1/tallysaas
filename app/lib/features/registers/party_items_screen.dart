import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// "Items Sold" / "Items Purchased" for one party — what this customer took
/// from us, or what we took from this supplier, rolled up per stock item.
/// LiveKeeping parity (the two tabs on its party detail page).
///
/// Returns are EXCLUDED rather than netted: the question is what actually
/// moved, and quietly subtracting a return reads as though it never shipped.
class PartyItemsScreen extends ConsumerStatefulWidget {
  const PartyItemsScreen({
    super.key,
    required this.partyId,
    required this.partyName,
    required this.purchased,
  });

  final int partyId;
  final String partyName;

  /// false → Items Sold (a customer), true → Items Purchased (a supplier).
  final bool purchased;

  @override
  ConsumerState<PartyItemsScreen> createState() => _PartyItemsScreenState();
}

class _PartyItemsScreenState extends ConsumerState<PartyItemsScreen> {
  Future<Map<String, dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final base = widget.purchased ? '/suppliers' : '/customers';
    final data = await ref.read(apiClientProvider).get('$base/${widget.partyId}/items');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.purchased ? 'Items Purchased' : 'Items Sold'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh)],
      ),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Could not load items.', style: TextStyle(color: AppColors.text2)),
                  TextButton(onPressed: _refresh, child: const Text('Retry')),
                ],
              ),
            );
          }
          final body = snap.data ?? const {};
          final rows = (body['data'] as List<dynamic>? ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
          final meta = body['meta'] as Map<String, dynamic>? ?? const {};

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md12),
              children: [
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.partyName,
                          style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Expanded(child: _stat('Total Value', Fmt.inr(_n(meta['total_amount'])))),
                          Expanded(child: _stat('Quantity', Fmt.num0(_n(meta['total_qty'])))),
                          Expanded(child: _stat('Items', '${meta['items'] ?? 0}')),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.md12),
                if (rows.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(
                      child: Text(
                        widget.purchased
                            ? 'No items purchased from this party.'
                            : 'No items sold to this party.',
                        style: const TextStyle(color: AppColors.text3),
                      ),
                    ),
                  )
                else
                  ...rows.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _itemRow(r),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: AppColors.text3)),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
      ],
    );
  }

  Widget _itemRow(Map<String, dynamic> r) {
    final unit = '${r['unit'] ?? ''}';
    final last = r['last_date'];
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${r['name'] ?? ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                Text(
                  [
                    '${Fmt.num0(_n(r['qty']))}${unit.isEmpty ? '' : ' $unit'}',
                    '${Fmt.num0(_n(r['vouchers']))} vouchers',
                    if (last != null) Fmt.date(last),
                  ].join('  •  '),
                  style: const TextStyle(fontSize: 12, color: AppColors.text2),
                ),
              ],
            ),
          ),
          Text(Fmt.inr(_n(r['amount'])),
              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
        ],
      ),
    );
  }
}
