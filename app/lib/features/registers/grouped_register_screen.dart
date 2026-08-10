import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// One way a register can regroup its period. `stock` marks the three views
/// that only exist for a voucher family that carries inventory.
class RegisterView {
  const RegisterView(this.key, this.label, {this.stock = false});
  final String key;
  final String label;
  final bool stock;
}

const registerViews = <RegisterView>[
  RegisterView('ledger', 'Ledger'),
  RegisterView('stock_item', 'Stock Item', stock: true),
  RegisterView('voucher_type', 'Voucher Type'),
  RegisterView('ledger_group', 'Ledger Group'),
  RegisterView('stock_group', 'Stock Group', stock: true),
  RegisterView('stock_category', 'Stock Category', stock: true),
];

/// The grouped view of any voucher register — Credit/Debit Note, Sales/
/// Purchase Order, Delivery/Receipt Note, Receipt, Payment. Sales and purchase
/// INVOICES have their own register screen (they also carry a month view), so
/// they do not route here.
///
/// Reads `GET <basePath>/grouped?by=…`, the same endpoint the web register
/// uses, so a figure can never differ between the two surfaces.
class GroupedRegisterScreen extends ConsumerStatefulWidget {
  const GroupedRegisterScreen({
    super.key,
    required this.basePath,
    required this.title,
    this.hasStock = true,
    this.initialView = 'ledger',
  });

  final String basePath;
  final String title;
  final bool hasStock;

  /// Which grouping the screen opens on. The Reports hub uses this so "By
  /// Stock Item" actually lands on the stock-item view instead of the default.
  final String initialView;

  @override
  ConsumerState<GroupedRegisterScreen> createState() => _GroupedRegisterScreenState();
}

class _GroupedRegisterScreenState extends ConsumerState<GroupedRegisterScreen> {
  Future<Map<String, dynamic>>? _future;
  late String _view = widget.initialView;

  List<RegisterView> get _views =>
      registerViews.where((v) => widget.hasStock || !v.stock).toList();

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await ref.read(apiClientProvider)
        .get('${widget.basePath}/grouped', query: {'by': _view});
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
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
                  const Text('Could not load the register.', style: TextStyle(color: AppColors.text2)),
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
          final hasQty = meta['has_qty'] == true;

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
                          label: Text(v.label),
                          selected: _view == v.key,
                          onSelected: (_) {
                            if (_view == v.key) return;
                            setState(() {
                              _view = v.key;
                              _future = _load();
                            });
                          },
                          labelStyle: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: _view == v.key ? Colors.white : AppColors.text2,
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
                            Text('Total · by ${meta['label'] ?? _view}',
                                style: const TextStyle(fontSize: 11.5, color: AppColors.text2)),
                            Text(Fmt.inr(_n(meta['grand_total'])),
                                style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: AppColors.text1)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text('${meta['groups'] ?? 0}',
                              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: AppColors.primary)),
                          const Text('groups', style: TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ],
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
                        child: _groupRow(g, hasQty),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _groupRow(Map<String, dynamic> g, bool hasQty) {
    final qty = g['qty'];
    final sub = hasQty && qty != null
        ? '${Fmt.num0(_n(g['count']))} vouchers · ${Fmt.num0(qty)} qty'
        : '${Fmt.num0(_n(g['count']))} vouchers';
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${g['name'] ?? ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                Text(sub, style: const TextStyle(fontSize: 12, color: AppColors.text2)),
              ],
            ),
          ),
          Text(Fmt.inr(_n(g['amount'])),
              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
        ],
      ),
    );
  }
}
