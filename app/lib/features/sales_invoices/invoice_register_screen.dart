import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/filter_sheet.dart';

const _monShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "YYYY-MM" → "Feb 2023".
String _monthLabel(String ym) {
  final p = ym.split('-');
  if (p.length != 2) return ym;
  final m = int.tryParse(p[1]) ?? 0;
  return (m >= 1 && m <= 12) ? '${_monShort[m - 1]} ${p[0]}' : ym;
}

/// Last day of a "YYYY-MM" month, as "YYYY-MM-DD".
String _monthEnd(String ym) {
  final p = ym.split('-');
  final y = int.tryParse(p[0]) ?? 2000, m = int.tryParse(p[1]) ?? 1;
  final last = DateTime(y, m + 1, 0).day;
  return '$ym-${last.toString().padLeft(2, '0')}';
}

/// One way the register can regroup the period. `month` is the built-in
/// month-wise view; the rest come from the api's `<basePath>/grouped` endpoint.
/// `stock` marks the three views that only exist for inventory vouchers.
class _RegView {
  const _RegView(this.key, this.label, {this.stock = false});
  final String key;
  final String label;
  final bool stock;
}

const _regViews = <_RegView>[
  _RegView('month', 'Month'),
  _RegView('ledger', 'Ledger'),
  _RegView('stock_item', 'Stock Item', stock: true),
  _RegView('voucher_type', 'Voucher Type'),
  _RegView('ledger_group', 'Ledger Group'),
  _RegView('stock_group', 'Stock Group', stock: true),
  _RegView('stock_category', 'Stock Category', stock: true),
];

/// Invoice Register — month-wise summary (mirrors the web): a grand-total + a
/// month-wise bar chart + a list of months (count, total). Tapping a month
/// drills into that month's invoices. Shared by Sales + Purchase via params.
///
/// The view chips regroup the SAME period by Ledger, Stock Item, Voucher Type,
/// Ledger Group, Stock Group or Stock Category, and the Gross/Net toggle picks
/// whether returns are excluded or subtracted — the same two controls the web
/// register and LiveKeeping both carry.
class InvoiceRegisterScreen extends ConsumerStatefulWidget {
  const InvoiceRegisterScreen({
    super.key,
    required this.title,
    required this.monthlyPath, // e.g. '/sales-invoices/monthly'
    required this.basePath,    // e.g. '/sales-invoices'
    required this.module,      // 'sales-invoices' | 'purchase-invoices'
    this.hasStock = true,      // false for Receipt/Payment — no inventory
  });

  final String title;
  final String monthlyPath;
  final String basePath;
  final String module;
  final bool hasStock;

  @override
  ConsumerState<InvoiceRegisterScreen> createState() => _InvoiceRegisterScreenState();
}

class _InvoiceRegisterScreenState extends ConsumerState<InvoiceRegisterScreen> {
  Future<Map<String, dynamic>>? _future;
  DateTime? _from;
  DateTime? _to;
  String _view = 'month';
  bool _net = false;

  /// The views this register offers — the stock ones drop out for a voucher
  /// kind that carries no inventory.
  List<_RegView> get _views =>
      _regViews.where((v) => widget.hasStock || !v.stock).toList();

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<Map<String, dynamic>> _load() async {
    final q = <String, dynamic>{};
    if (_from != null && _to != null) {
      q['date_from'] = _ymd(_from!);
      q['date_to'] = _ymd(_to!);
    }
    // Month keeps its own endpoint (it carries the running closing balance the
    // grouped endpoint has no concept of); every other view is one grouped call.
    if (_view == 'month') {
      final data = await ref.read(apiClientProvider).get(widget.monthlyPath, query: q.isEmpty ? null : q);
      return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
    }
    q['by'] = _view;
    q['mode'] = _net ? 'net' : 'gross';
    final data = await ref.read(apiClientProvider).get('${widget.basePath}/grouped', query: q);
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  void _setView(String key) {
    if (_view == key) return;
    setState(() {
      _view = key;
      _future = _load();
    });
  }

  void _setNet(bool net) {
    if (_net == net) return;
    setState(() {
      _net = net;
      _future = _load();
    });
  }

  Future<void> _openFilter() async {
    final res = await showFilterSheet(context, dateRange: true, currentFrom: _from, currentTo: _to);
    if (res == null) return;
    setState(() {
      if (res.cleared) {
        _from = null;
        _to = null;
      } else {
        _from = res.from;
        _to = res.to;
      }
      _future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can(widget.module, 'create') ?? false;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          IconButton(
            icon: Icon((_from != null && _to != null) ? Icons.filter_alt : Icons.tune),
            color: (_from != null && _to != null) ? AppColors.primary : null,
            tooltip: 'Filter (date range)',
            onPressed: _openFilter,
          ),
          IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh),
        ],
      ),
      floatingActionButton: !canCreate
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final created = await context.push<bool>('${widget.basePath}/add');
                if (created == true) _refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return _retry('Could not load the register.', _refresh);
          }
          final body = snap.data ?? const {};
          final rows = (body['data'] as List<dynamic>? ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
          final meta = body['meta'] as Map<String, dynamic>? ?? const {};
          final grand = (meta['grand_total'] is num) ? meta['grand_total'] as num : num.tryParse('${meta['grand_total']}') ?? 0;
          final isMonth = _view == 'month';
          final hasQty = meta['has_qty'] == true;

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md12),
              children: [
                _viewChips(),
                const SizedBox(height: AppSpacing.md12),
                _grandCard(grand, rows.length, isMonth),
                const SizedBox(height: AppSpacing.md12),
                // The bar chart only reads as a trend on the month view; a
                // grouped view's rows have no time order to plot.
                if (isMonth && rows.isNotEmpty) _chart(rows),
                if (isMonth && rows.isNotEmpty) const SizedBox(height: AppSpacing.md12),
                Text(
                  isMonth ? 'Month-wise' : 'By ${meta['label'] ?? _view}',
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1),
                ),
                const SizedBox(height: AppSpacing.sm8),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(child: Text('No data available.', style: TextStyle(color: AppColors.text3))),
                  )
                else if (isMonth)
                  ...rows.reversed.map((m) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _monthRow(m),
                      ))
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

  /// The view switcher + the Gross/Net toggle. Gross/Net only applies to the
  /// grouped views — the month register always ties to Tally's own figures.
  Widget _viewChips() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final v in _views) ...[
                ChoiceChip(
                  label: Text(v.label),
                  selected: _view == v.key,
                  onSelected: (_) => _setView(v.key),
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
        if (_view != 'month') ...[
          const SizedBox(height: AppSpacing.sm8),
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: false, label: Text('Gross')),
              ButtonSegment(value: true, label: Text('Net')),
            ],
            selected: {_net},
            onSelectionChanged: (s) => _setNet(s.first),
            showSelectedIcon: false,
            style: const ButtonStyle(visualDensity: VisualDensity.compact),
          ),
        ],
      ],
    );
  }

  Widget _grandCard(num grand, int count, bool isMonth) {
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Grand Total', style: TextStyle(fontSize: 12, color: AppColors.text2)),
                const SizedBox(height: 2),
                Text(Fmt.inr(grand), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AppColors.text1)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('$count', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.primary)),
              Text(isMonth ? 'months' : 'groups', style: const TextStyle(fontSize: 11, color: AppColors.text3)),
            ],
          ),
        ],
      ),
    );
  }

  /// One grouped row — name, voucher count (and quantity on the stock views),
  /// and the group's amount. Tapping drills into that group's vouchers.
  Widget _groupRow(Map<String, dynamic> g, bool hasQty) {
    final name = '${g['name'] ?? ''}';
    final amount = (g['amount'] is num) ? g['amount'] as num : num.tryParse('${g['amount']}') ?? 0;
    final count = (g['count'] is num) ? g['count'] as num : num.tryParse('${g['count']}') ?? 0;
    final qty = (g['qty'] is num) ? g['qty'] as num : num.tryParse('${g['qty']}');
    final sub = hasQty && qty != null
        ? '${Fmt.num0(count)} vouchers · ${Fmt.num0(qty)} qty'
        : '${Fmt.num0(count)} vouchers';
    return AppCard(
      onTap: () => context.push('${widget.basePath}?search=${Uri.encodeComponent(name)}'),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                Text(sub, style: const TextStyle(fontSize: 12, color: AppColors.text2)),
              ],
            ),
          ),
          Text(Fmt.inr(amount), style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }

  Widget _chart(List<Map<String, dynamic>> months) {
    final data = months.map((m) => (m['total'] is num) ? (m['total'] as num).toDouble() : double.tryParse('${m['total']}') ?? 0).toList();
    final labels = months.map((m) => _monthLabel('${m['month']}').split(' ').first).toList();
    final maxV = data.isEmpty ? 0.0 : data.reduce((a, b) => a > b ? a : b);
    final maxY = maxV <= 0 ? 1.0 : maxV * 1.25;
    return AppCard(
      child: SizedBox(
        height: 170,
        child: BarChart(BarChartData(
          alignment: BarChartAlignment.spaceAround,
          maxY: maxY,
          barTouchData: BarTouchData(enabled: false),
          gridData: const FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 20,
                getTitlesWidget: (value, meta) {
                  final i = value.toInt();
                  if (i < 0 || i >= labels.length) return const SizedBox.shrink();
                  // thin out labels when many months
                  if (labels.length > 8 && i % 2 != 0) return const SizedBox.shrink();
                  return Padding(padding: const EdgeInsets.only(top: 4), child: Text(labels[i], style: const TextStyle(fontSize: 8, color: AppColors.text3)));
                },
              ),
            ),
          ),
          barGroups: [
            for (var i = 0; i < data.length; i++)
              BarChartGroupData(x: i, barRods: [
                BarChartRodData(toY: data[i], color: AppColors.primary, width: 8, borderRadius: const BorderRadius.vertical(top: Radius.circular(2))),
              ]),
          ],
        )),
      ),
    );
  }

  Widget _monthRow(Map<String, dynamic> m) {
    final ym = '${m['month']}';
    final total = (m['total'] is num) ? m['total'] as num : num.tryParse('${m['total']}') ?? 0;
    final count = (m['count'] is num) ? m['count'] as num : num.tryParse('${m['count']}') ?? 0;
    return AppCard(
      onTap: () => context.push('${widget.basePath}/month/$ym'),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_monthLabel(ym), style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                Text('${Fmt.num0(count)} vouchers', style: const TextStyle(fontSize: 12, color: AppColors.text2)),
              ],
            ),
          ),
          Text(Fmt.inr(total), style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}

/// One month's invoices (the drill-down target). Fetches the month's range
/// directly from [basePath]?date_from&date_to.
class MonthInvoicesScreen extends ConsumerStatefulWidget {
  const MonthInvoicesScreen({super.key, required this.basePath, required this.month});
  final String basePath; // '/sales-invoices'
  final String month;    // 'YYYY-MM'

  @override
  ConsumerState<MonthInvoicesScreen> createState() => _MonthInvoicesScreenState();
}

class _MonthInvoicesScreenState extends ConsumerState<MonthInvoicesScreen> {
  Future<List<dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<dynamic>> _load() async {
    final data = await ref.read(apiClientProvider).get(widget.basePath, query: {
      'date_from': '${widget.month}-01',
      'date_to': _monthEnd(widget.month),
      'per_page': 100, // listInvoiceSchema caps per_page at 100
    });
    if (data is List) return data;
    if (data is Map) return (data['data'] as List<dynamic>? ?? data['rows'] as List<dynamic>? ?? const []);
    return const [];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_monthLabel(widget.month))),
      body: FutureBuilder<List<dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return _retry('Could not load invoices.', () => setState(() => _future = _load()));
          }
          final rows = snap.data ?? const [];
          if (rows.isEmpty) {
            return const Center(child: Text('No invoices in this month.', style: TextStyle(color: AppColors.text3)));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(AppSpacing.md12),
            itemCount: rows.length,
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              final m = Map<String, dynamic>.from(rows[i] as Map);
              final total = (m['total'] is num) ? m['total'] as num : num.tryParse('${m['total']}') ?? 0;
              final id = m['id'];
              return AppCard(
                onTap: id == null ? null : () => context.push('${widget.basePath}/$id'),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${m['invoice_no'] ?? '-'}', style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                          Text('${m['customer'] ?? m['supplier'] ?? m['party'] ?? ''}',
                              maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                        ],
                      ),
                    ),
                    Text(Fmt.inr(total), style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  }
}

Widget _retry(String message, VoidCallback onRetry) {
  return Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.error_outline, size: 40, color: AppColors.danger),
        const SizedBox(height: AppSpacing.sm8),
        Text(message, style: const TextStyle(color: AppColors.text2)),
        const SizedBox(height: AppSpacing.md12),
        OutlinedButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Retry')),
      ],
    ),
  );
}
