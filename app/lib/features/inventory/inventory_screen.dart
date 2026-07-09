import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';

/// Inventory / Stock — read-only stock position per product, mirroring the web
/// (/inventory): a stats strip + a searchable list (product, current qty, value,
/// status). Data: GET /inventory { stats, data[], meta }.
class InventoryScreen extends ConsumerStatefulWidget {
  const InventoryScreen({super.key});

  @override
  ConsumerState<InventoryScreen> createState() => _InventoryScreenState();
}

class _InventoryScreenState extends ConsumerState<InventoryScreen> {
  final _searchCtl = TextEditingController();
  String _query = '';
  Map<String, String> _adv = {};
  int _reload = 0;
  Future<Map<String, dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _searchCtl.dispose();
    super.dispose();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await ref.read(apiClientProvider).get(
      Endpoints.inventory,
      query: {
        'per_page': 100,
        if (_query.isNotEmpty) 'search': _query,
        ..._adv,
      },
    );
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _runSearch() {
    setState(() {
      _query = _searchCtl.text.trim();
      _reload++;
      _future = _load();
    });
  }

  static const _fields = [
    FilterField('status', 'Stock Status', FType.select, options: ['In Stock', 'Low Stock', 'Out of Stock']),
    FilterField('location', 'Location', FType.dynamicSelect, endpoint: '/locations'),
  ];

  Future<void> _openFilter() async {
    final res = await showAdvancedFilter(context, ref, title: 'Inventory filter', fields: _fields, current: _adv);
    if (res == null) return;
    setState(() {
      _adv = res;
      _reload++;
      _future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Inventory / Stock'),
        actions: [
          const ModuleInfoButton('inventory'),
          IconButton(
            icon: Icon(_adv.isNotEmpty ? Icons.filter_alt : Icons.tune),
            color: _adv.isNotEmpty ? AppColors.primary : null,
            tooltip: 'Filter',
            onPressed: _openFilter,
          ),
        ],
      ),
      body: Column(
        children: [
          // Search bar
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.sm8, AppSpacing.md12, AppSpacing.sm8),
            child: TextField(
              controller: _searchCtl,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _runSearch(),
              decoration: InputDecoration(
                hintText: 'Search product…',
                prefixIcon: const Icon(Icons.search, size: 20),
                suffixIcon: _searchCtl.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () {
                          _searchCtl.clear();
                          _runSearch();
                        },
                      ),
                isDense: true,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.sm8)),
              ),
            ),
          ),
          Expanded(
            child: FutureBuilder<Map<String, dynamic>>(
              key: ValueKey(_reload),
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snap.hasError) {
                  return _retry('Could not load inventory.');
                }
                final body = snap.data ?? const {};
                final stats = body['stats'] as Map<String, dynamic>? ?? const {};
                final rows = (body['data'] as List<dynamic>? ?? const []);
                final meta = body['meta'] as Map<String, dynamic>? ?? const {};

                return RefreshIndicator(
                  onRefresh: () async => _runSearch(),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.md12),
                    children: [
                      _statsStrip(stats, meta),
                      const SizedBox(height: AppSpacing.sm8),
                      if (rows.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                          child: Center(child: Text('No stock items.', style: TextStyle(color: AppColors.text3))),
                        )
                      else
                        ...rows.map((r) => Padding(
                              padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                              child: _row(r is Map ? Map<String, dynamic>.from(r) : {}),
                            )),
                      if (rows.isNotEmpty && _moreThanShown(meta, rows.length))
                        Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.md12),
                          child: Center(
                            child: Text(
                              'Showing first ${rows.length} of ${meta['total'] ?? rows.length} — search to narrow.',
                              style: const TextStyle(fontSize: 12, color: AppColors.text3),
                            ),
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  bool _moreThanShown(Map<String, dynamic> meta, int shown) {
    final total = (meta['total'] is num) ? meta['total'] as num : num.tryParse('${meta['total']}') ?? shown;
    return total > shown;
  }

  Widget _statsStrip(Map<String, dynamic> stats, Map<String, dynamic> meta) {
    num n(Map m, String k) => (m[k] is num) ? m[k] as num : num.tryParse('${m[k]}') ?? 0;
    final items = n(meta, 'total') != 0 ? n(meta, 'total') : n(stats, 'skus');
    final value = n(stats, 'total_value') != 0 ? n(stats, 'total_value') : n(stats, 'stock_value');
    final low = n(stats, 'low');
    final out = n(stats, 'out');
    return Row(
      children: [
        _stat('Items', Fmt.num0(items), const Color(0xFF2563EB)),
        _stat('Stock Value', Fmt.inr(value), const Color(0xFF16A34A)),
        _stat('Low', Fmt.num0(low), const Color(0xFFD97706)),
        _stat('Out', Fmt.num0(out), const Color(0xFFDC2626)),
      ],
    );
  }

  Widget _stat(String label, String value, Color color) {
    return Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: AppCard(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(value, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: color)),
              Text(label, style: const TextStyle(fontSize: 10, color: AppColors.text2)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(Map<String, dynamic> m) {
    final current = (m['current'] is num) ? m['current'] as num : num.tryParse('${m['current']}') ?? 0;
    final value = (m['value'] is num) ? m['value'] as num : num.tryParse('${m['value']}') ?? 0;
    final status = '${m['status_label'] ?? ''}';
    final statusColor = status.toLowerCase().contains('out')
        ? const Color(0xFFDC2626)
        : (status.toLowerCase().contains('low') ? const Color(0xFFD97706) : const Color(0xFF16A34A));
    return AppCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md12, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${m['product'] ?? '-'}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                const SizedBox(height: 2),
                Text(
                  [m['category'], m['unit']].where((e) => e != null && '$e'.isNotEmpty).join(' · '),
                  style: const TextStyle(fontSize: 12, color: AppColors.text2),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('Qty ${Fmt.num0(current)}',
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
              Text(Fmt.inr(value), style: const TextStyle(fontSize: 12, color: AppColors.text2)),
              if (status.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 3),
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: statusColor.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(status, style: TextStyle(fontSize: 10, color: statusColor, fontWeight: FontWeight.w600)),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _retry(String message) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, size: 40, color: AppColors.danger),
          const SizedBox(height: AppSpacing.sm8),
          Text(message, style: const TextStyle(color: AppColors.text2)),
          const SizedBox(height: AppSpacing.md12),
          OutlinedButton.icon(onPressed: _runSearch, icon: const Icon(Icons.refresh), label: const Text('Retry')),
        ],
      ),
    );
  }
}
