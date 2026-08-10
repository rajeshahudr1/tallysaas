import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// The Items screen's grouped views — closing stock and its value rolled up by
/// Stock Group, Stock Category or Godown instead of item by item.
///
/// The Godown view reports MOVEMENT, not a closing balance: opening stock is
/// recorded against the item and carries no godown, so splitting it across
/// godowns would mean inventing a distribution. The header says so rather than
/// labelling a movement figure as a balance.
class StockGroupingScreen extends ConsumerStatefulWidget {
  const StockGroupingScreen({super.key});

  @override
  ConsumerState<StockGroupingScreen> createState() => _StockGroupingScreenState();
}

class _StockGroupingScreenState extends ConsumerState<StockGroupingScreen> {
  static const _views = <MapEntry<String, String>>[
    MapEntry('group', 'Group'),
    MapEntry('godown', 'Godown'),
    MapEntry('category', 'Category'),
  ];

  Future<Map<String, dynamic>>? _future;
  String _by = 'group';

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await ref.read(apiClientProvider).get('/items/grouped', query: {'by': _by});
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Stock Summary'),
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
                  const Text('Could not load stock.', style: TextStyle(color: AppColors.text2)),
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
          final movementOnly = meta['movement_only'] == true;

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md12),
              children: [
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final v in _views) ...[
                        ChoiceChip(
                          label: Text(v.value),
                          selected: _by == v.key,
                          onSelected: (_) {
                            if (_by == v.key) return;
                            setState(() {
                              _by = v.key;
                              _future = _load();
                            });
                          },
                          labelStyle: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: _by == v.key ? Colors.white : AppColors.text2,
                          ),
                          selectedColor: AppColors.primary,
                          backgroundColor: Colors.white,
                          showCheckmark: false,
                        ),
                        const SizedBox(width: AppSpacing.sm8),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.md12),
                AppCard(
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              movementOnly ? 'Net Movement Value' : 'Closing Stock Value',
                              style: const TextStyle(fontSize: 11.5, color: AppColors.text2),
                            ),
                            Text(Fmt.inr(_n(meta['total_value'])),
                                style: const TextStyle(
                                    fontSize: 19, fontWeight: FontWeight.w800, color: AppColors.text1)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(Fmt.num0(_n(meta['total_qty'])),
                              style: const TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.primary)),
                          const Text('quantity', style: TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ],
                  ),
                ),
                if (movementOnly)
                  const Padding(
                    padding: EdgeInsets.only(top: AppSpacing.sm8),
                    child: Text(
                      'Godown figures show movement only — opening stock carries no godown.',
                      style: TextStyle(fontSize: 11.5, color: AppColors.text3),
                    ),
                  ),
                const SizedBox(height: AppSpacing.md12),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(child: Text('No data available.', style: TextStyle(color: AppColors.text3))),
                  )
                else
                  ...rows.map((g) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _groupRow(g),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _groupRow(Map<String, dynamic> g) {
    final qty = _n(g['closing_qty']);
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${g['name'] ?? ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                // A negative quantity is real in Tally (goods issued before
                // they were received) — flag it rather than hide it.
                Text('${Fmt.num0(_n(g['items']))} items  •  ${Fmt.num0(qty)} qty',
                    style: TextStyle(
                      fontSize: 12,
                      color: qty < 0 ? AppColors.danger : AppColors.text2,
                    )),
              ],
            ),
          ),
          Text(Fmt.inr(_n(g['closing_value'])),
              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
        ],
      ),
    );
  }
}
