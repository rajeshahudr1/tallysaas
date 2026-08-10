import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// Tally's cost-centre reports: the summary, and the same spend split by the
/// ledger or by the ledger's group.
///
/// Amounts carry Tally's own sign — a cost report exists to show what was
/// recorded, so nothing here is re-signed or made positive for looks.
class CostCentreScreen extends ConsumerStatefulWidget {
  const CostCentreScreen({super.key});

  @override
  ConsumerState<CostCentreScreen> createState() => _CostCentreScreenState();
}

class _CostCentreScreenState extends ConsumerState<CostCentreScreen> {
  static const _views = <MapEntry<String, String>>[
    MapEntry('', 'Summary'),
    MapEntry('ledger', 'Ledger Breakup'),
    MapEntry('group', 'Group Breakup'),
  ];

  Future<Map<String, dynamic>>? _future;
  String _by = '';

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final client = ref.read(apiClientProvider);
    final data = _by.isEmpty
        ? await client.get('/cost-centres/summary')
        : await client.get('/cost-centres/breakup', query: {'by': _by});
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cost Centres'),
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
                  const Text('Could not load cost centres.',
                      style: TextStyle(color: AppColors.text2)),
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
                            Text('${meta['label'] ?? 'Cost Centres'} · Total',
                                style: const TextStyle(fontSize: 11.5, color: AppColors.text2)),
                            Text(Fmt.inr(_n(meta['total_amount'])),
                                style: const TextStyle(
                                    fontSize: 19, fontWeight: FontWeight.w800, color: AppColors.text1)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text('${meta['rows'] ?? 0}',
                              style: const TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.primary)),
                          const Text('rows', style: TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.md12),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(
                      child: Text('No cost-centre allocations recorded.',
                          style: TextStyle(color: AppColors.text3)),
                    ),
                  )
                else
                  ...rows.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _row(r),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _row(Map<String, dynamic> r) {
    final amount = _n(r['amount']);
    final category = r['category'];
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
                    if (category != null) '$category',
                    '${Fmt.num0(_n(r['vouchers']))} vouchers',
                  ].join('  •  '),
                  style: const TextStyle(fontSize: 12, color: AppColors.text2),
                ),
              ],
            ),
          ),
          Text(Fmt.inr(amount),
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: amount < 0 ? AppColors.danger : AppColors.text1,
              )),
        ],
      ),
    );
  }
}
