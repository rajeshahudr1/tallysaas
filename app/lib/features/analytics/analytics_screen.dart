import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Business Analytics — a read-only insights dashboard (sales trend, cash flow,
/// receivables aging, top customers/products, KPIs). One bundle from
/// GET /account/analytics. Mirrors the web Analytics page.
final _analyticsProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/account/analytics');
  return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
});

const _kGreen = Color(0xFF16A34A);
const _kRed = Color(0xFFDC2626);
const _kAmber = Color(0xFFF59E0B);
const _kOrange = Color(0xFFEA580C);

List<double> _dbl(dynamic list) => (list as List?)
        ?.map((e) => (e is num) ? e.toDouble() : double.tryParse('$e') ?? 0.0)
        .toList() ??
    const [];

List<String> _str(dynamic list) => (list as List?)?.map((e) => '$e').toList() ?? const [];

class AnalyticsScreen extends ConsumerWidget {
  const AnalyticsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_analyticsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Business Analytics'), actions: const [ModuleInfoButton('reports')]),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load analytics.',
          onRetry: () => ref.invalidate(_analyticsProvider),
        ),
        data: (d) {
          final k = (d['kpis'] as Map?)?.cast<String, dynamic>() ?? const {};
          final st = (d['sales_trend'] as Map?)?.cast<String, dynamic>() ?? const {};
          final cf = (d['cashflow'] as Map?)?.cast<String, dynamic>() ?? const {};
          final tc = (d['top_customers'] as List?)?.whereType<Map>().toList() ?? const [];
          final tp = (d['top_products'] as List?)?.whereType<Map>().toList() ?? const [];
          final ag = (d['aging'] as List?)?.whereType<Map>().toList() ?? const [];
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_analyticsProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              children: [
                _kpiGrid(k),
                const SizedBox(height: AppSpacing.sm8),
                _salesTrendCard(st),
                const SizedBox(height: AppSpacing.sm8),
                _cashflowCard(cf),
                const SizedBox(height: AppSpacing.sm8),
                _agingCard(ag),
                const SizedBox(height: AppSpacing.sm8),
                _topListCard('Top Customers', tc, 'total', AppColors.primary),
                const SizedBox(height: AppSpacing.sm8),
                _topListCard('Top Products', tp, 'value', _kGreen),
              ],
            ),
          );
        },
      ),
    );
  }

  // ── KPI grid (2×2) ─────────────────────────────────────────────
  Widget _kpiGrid(Map<String, dynamic> k) {
    Widget kpi(String label, Object? v, Color color) => Expanded(
          child: AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: const TextStyle(fontSize: 11, color: AppColors.text3, fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text(Fmt.inr(v),
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: color)),
              ],
            ),
          ),
        );
    return Column(
      children: [
        Row(children: [
          kpi('Total Sales', k['total_sales'], AppColors.text1),
          const SizedBox(width: AppSpacing.sm8),
          kpi('This Month', k['sales_this_month'], AppColors.primary),
        ]),
        const SizedBox(height: AppSpacing.sm8),
        Row(children: [
          kpi('Receipts', k['total_receipts'], _kGreen),
          const SizedBox(width: AppSpacing.sm8),
          kpi('Receivable', k['total_receivable'], _kRed),
        ]),
      ],
    );
  }

  // ── Sales trend (single-series bars) ───────────────────────────
  Widget _salesTrendCard(Map<String, dynamic> st) {
    final labels = _str(st['labels']);
    final data = _dbl(st['data']);
    final maxV = data.isEmpty ? 0.0 : data.reduce((a, b) => a > b ? a : b);
    final maxY = maxV <= 0 ? 1.0 : maxV * 1.25;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Sales Trend (12 months)',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.md12),
          SizedBox(
            height: 170,
            child: data.isEmpty
                ? const Center(child: Text('—', style: TextStyle(color: AppColors.text3)))
                : BarChart(BarChartData(
                    alignment: BarChartAlignment.spaceAround,
                    maxY: maxY,
                    barTouchData: BarTouchData(enabled: false),
                    gridData: const FlGridData(show: false),
                    borderData: FlBorderData(show: false),
                    titlesData: _monthTitles(labels),
                    barGroups: [
                      for (var i = 0; i < data.length; i++)
                        BarChartGroupData(x: i, barRods: [
                          BarChartRodData(toY: data[i], color: AppColors.primary, width: 8, borderRadius: const BorderRadius.vertical(top: Radius.circular(2))),
                        ]),
                    ],
                  )),
          ),
        ],
      ),
    );
  }

  // ── Cash flow (grouped bars: in green, out red) ────────────────
  Widget _cashflowCard(Map<String, dynamic> cf) {
    final labels = _str(cf['labels']);
    final inflow = _dbl(cf['inflow']);
    final outflow = _dbl(cf['outflow']);
    final all = [...inflow, ...outflow];
    final maxV = all.isEmpty ? 0.0 : all.reduce((a, b) => a > b ? a : b);
    final maxY = maxV <= 0 ? 1.0 : maxV * 1.25;
    final n = inflow.length;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            const Text('Cash Flow (12 months)',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
            const Spacer(),
            _legendDot(_kGreen, 'In'),
            const SizedBox(width: 10),
            _legendDot(_kRed, 'Out'),
          ]),
          const SizedBox(height: AppSpacing.md12),
          SizedBox(
            height: 170,
            child: n == 0
                ? const Center(child: Text('—', style: TextStyle(color: AppColors.text3)))
                : BarChart(BarChartData(
                    alignment: BarChartAlignment.spaceAround,
                    maxY: maxY,
                    barTouchData: BarTouchData(enabled: false),
                    gridData: const FlGridData(show: false),
                    borderData: FlBorderData(show: false),
                    titlesData: _monthTitles(labels),
                    barGroups: [
                      for (var i = 0; i < n; i++)
                        BarChartGroupData(x: i, barsSpace: 2, barRods: [
                          BarChartRodData(toY: inflow[i], color: _kGreen, width: 4, borderRadius: const BorderRadius.vertical(top: Radius.circular(2))),
                          BarChartRodData(toY: i < outflow.length ? outflow[i] : 0, color: _kRed, width: 4, borderRadius: const BorderRadius.vertical(top: Radius.circular(2))),
                        ]),
                    ],
                  )),
          ),
        ],
      ),
    );
  }

  // ── Receivables aging (horizontal bars) ────────────────────────
  Widget _agingCard(List<Map> ag) {
    final colors = [_kGreen, _kAmber, _kOrange, _kRed];
    final total = ag.fold<double>(0, (s, b) => s + Fmt.n(b['amount']).toDouble());
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Receivables Aging',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.md12),
          for (var i = 0; i < ag.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  SizedBox(width: 52, child: Text('${ag[i]['label']}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.text2))),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(999),
                      child: LinearProgressIndicator(
                        value: total <= 0 ? 0 : (Fmt.n(ag[i]['amount']).toDouble() / total).clamp(0.0, 1.0),
                        minHeight: 10,
                        backgroundColor: const Color(0xFFF1F5F9),
                        valueColor: AlwaysStoppedAnimation(colors[i % colors.length]),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  SizedBox(width: 82, child: Text(Fmt.inr(ag[i]['amount']), textAlign: TextAlign.right, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.text1), maxLines: 1, overflow: TextOverflow.ellipsis)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  // ── Top customers / products (list with bars) ──────────────────
  Widget _topListCard(String title, List<Map> rows, String valueKey, Color color) {
    final maxV = rows.fold<double>(0, (m, x) {
      final d = Fmt.n(x[valueKey]).toDouble();
      return d > m ? d : m;
    });
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.sm8),
          if (rows.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('No data yet.', style: TextStyle(color: AppColors.text3)))
          else
            for (final x in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${x['name'] ?? '—'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.text1)),
                          const SizedBox(height: 4),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(999),
                            child: LinearProgressIndicator(
                              value: maxV <= 0 ? 0 : (Fmt.n(x[valueKey]).toDouble() / maxV).clamp(0.02, 1.0),
                              minHeight: 7,
                              backgroundColor: const Color(0xFFF1F5F9),
                              valueColor: AlwaysStoppedAnimation(color),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(Fmt.inr(x[valueKey]), style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.text1)),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  FlTitlesData _monthTitles(List<String> labels) => FlTitlesData(
        leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
        rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
        topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
        bottomTitles: AxisTitles(
          sideTitles: SideTitles(
            showTitles: true,
            reservedSize: 22,
            interval: 1,
            getTitlesWidget: (value, meta) {
              final i = value.toInt();
              if (i < 0 || i >= labels.length || i % 2 != 0) return const SizedBox.shrink();
              return Padding(padding: const EdgeInsets.only(top: 4), child: Text(labels[i], style: const TextStyle(fontSize: 8, color: AppColors.text3)));
            },
          ),
        ),
      );

  Widget _legendDot(Color c, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 9, height: 9, decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(2))),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 11, color: AppColors.text3, fontWeight: FontWeight.w600)),
      ]);
}
