import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../notifications/notifications_screen.dart';
import '../field/field_dashboard_screen.dart';
import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/user.dart';
import '../../shared/widgets/app_card.dart';

/// Dashboard — mirrors the web home: a date-range filter, a grid of KPI cards
/// (RBAC-filtered), a Sales Overview chart, a Tally Sync Status doughnut, and
/// Recent Invoices + Recent Sync lists. Data: GET /dashboard/summary[?from&to].
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  Future<Map<String, dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    // Refresh /me so a super-admin's module (entitlement) change on the licence
    // reflects in the app menu + per-screen can() gates WITHOUT a re-login.
    // Fire-and-forget + best-effort (never blocks the dashboard or signs out).
    ref.read(authServiceProvider).refreshMe();
    // A salesman sees their FIELD dashboard here (below), so skip the company
    // dashboard fetch — they lack 'dashboard' permission and it would 403. A
    // non-salesman whose role has NO Dashboard module gets a welcome screen
    // (below) instead — also no fetch, so we don't 403.
    final session = ref.read(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canDash = user != null && !user.isSalesman && user.canModule('dashboard');
    if (canDash) _future = _load();
  }

  // All-time dashboard (no date filter) — the numbers match the web, which is
  // also all-time now.
  Future<Map<String, dynamic>> _load() async {
    final data = await ref.read(apiClientProvider).get(Endpoints.dashboardSummary);
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;

    // Role-based landing: a field salesman gets THEIR dashboard (My Field) — the
    // company KPI dashboard needs a 'dashboard' permission they don't have, which
    // is why it showed "Could not load the dashboard." for them.
    if (user != null && user.isSalesman) {
      return const FieldDashboardScreen();
    }

    // A signed-in user whose role has NO Dashboard module: show a friendly
    // welcome instead of the KPI cards (which would 403). Mirrors the web.
    if (user != null && !user.canModule('dashboard')) {
      return _WelcomeDashboard(name: user.name);
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        actions: [
          Consumer(builder: (_, r, __) {
            final unread = r.watch(notificationsUnreadProvider).maybeWhen(data: (n) => n, orElse: () => 0);
            return IconButton(
              icon: unread > 0
                  ? Badge(label: Text('$unread'), child: const Icon(Icons.notifications_outlined))
                  : const Icon(Icons.notifications_outlined),
              tooltip: 'Notifications',
              onPressed: () => context.push('/notifications'),
            );
          }),
          IconButton(icon: const Icon(Icons.refresh), tooltip: 'Refresh', onPressed: _refresh),
        ],
      ),
      body: Column(
        children: [
          _expiryBanner(user),
          Expanded(
            child: FutureBuilder<Map<String, dynamic>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snap.hasError) {
                  return _ErrorView(message: 'Could not load the dashboard.', onRetry: _refresh);
                }
                final data = snap.data ?? const {};
                return RefreshIndicator(
                  onRefresh: () async => _refresh(),
                  child: ListView(
                    padding: const EdgeInsets.all(AppSpacing.md12),
                    children: [
                      _kpiGrid(data['counts'] as Map<String, dynamic>? ?? const {}, user),
                      const SizedBox(height: AppSpacing.lg16),
                      _salesChartCard(data['sales_chart'] as Map<String, dynamic>? ?? const {}),
                      const SizedBox(height: AppSpacing.lg16),
                      _syncStatusCard(data['sync_chart'] as Map<String, dynamic>? ?? const {}),
                      const SizedBox(height: AppSpacing.lg16),
                      _recentInvoicesCard(data['recent_invoices'] as List<dynamic>? ?? const []),
                      const SizedBox(height: AppSpacing.lg16),
                      _recentSyncCard(data['recent_sync'] as List<dynamic>? ?? const []),
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

  // ── Licence expiry banner (company-admin only) ────────────────
  // Mirrors the web exactly: a warning strip at the very top when the
  // subscription is within 30 days of expiry (amber) or already expired (red);
  // nothing else, and ONLY for the company-admin (the licence manager) — a
  // salesman/plain user never sees it. Kept fresh by refreshMe() on load.
  Widget _expiryBanner(AppUser? user) {
    final lic = user?.license;
    if (user == null || user.roleSlug != 'company-admin' || lic == null || lic.daysLeft == null) {
      return const SizedBox.shrink();
    }
    final d = lic.daysLeft!;
    if (d >= 30) return const SizedBox.shrink();
    final expired = d < 0;
    final dateLbl = lic.validUntilLabel ?? '';
    final onLbl = dateLbl.isNotEmpty ? ' (on $dateLbl)' : '';
    final msg = expired
        ? 'Your subscription has expired$onLbl. Please renew to restore full access.'
        : 'Your subscription expires in $d day${d == 1 ? '' : 's'}$onLbl. Please renew to avoid interruption.';
    final fg = expired ? const Color(0xFF991B1B) : const Color(0xFF92400E);
    final bg = expired ? const Color(0xFFFEE2E2) : const Color(0xFFFEF3C7);
    final bd = expired ? const Color(0xFFFECACA) : const Color(0xFFFDE68A);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: bg, border: Border(bottom: BorderSide(color: bd))),
      padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.sm8, AppSpacing.md12, AppSpacing.sm8),
      child: Row(
        children: [
          Icon(expired ? Icons.error_outline : Icons.warning_amber_rounded, size: 18, color: fg),
          const SizedBox(width: 8),
          Expanded(
            child: Text(msg, style: TextStyle(fontSize: 12.5, color: fg, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  // ── KPI cards ──────────────────────────────────────────────────
  Widget _kpiGrid(Map<String, dynamic> c, AppUser? user) {
    num n(String k) => (c[k] is num) ? c[k] as num : num.tryParse('${c[k]}') ?? 0;
    bool can(String? m) => m == null || (user?.canModule(m) ?? true);
    final isAdmin = user?.isSuperAdmin ?? false;

    final cards = <_Kpi>[
      _Kpi('Total Companies', Fmt.num0(n('companies')), Icons.apartment, const Color(0xFF2563EB), 'companies'),
      _Kpi('Total Customers', Fmt.num0(n('customers')), Icons.groups_outlined, const Color(0xFF7C3AED), 'customers'),
      _Kpi('Total Products', Fmt.num0(n('products')), Icons.inventory_2_outlined, const Color(0xFF0D9488), 'products'),
      _Kpi("Today's Sales", Fmt.inr(n('today_sales')), Icons.currency_rupee, const Color(0xFF16A34A), 'sales-invoices'),
      if (isAdmin) _Kpi('Pending Tally Sync', Fmt.num0(n('pending_sync')), Icons.sync, const Color(0xFFD97706), null),
      _Kpi('Stock Value', Fmt.inr(n('stock_value')), Icons.warehouse_outlined, const Color(0xFF4F46E5), 'inventory'),
      _Kpi('Invoice Amount', Fmt.inr(n('invoice_amount')), Icons.receipt_long_outlined, const Color(0xFF2563EB), 'sales-invoices'),
      _Kpi('Payment Received', Fmt.inr(n('payment_received')), Icons.payments_outlined, const Color(0xFF16A34A), 'payments'),
    ].where((k) => can(k.module)).toList();

    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: AppSpacing.sm8,
      crossAxisSpacing: AppSpacing.sm8,
      childAspectRatio: 1.55,
      children: cards.map(_kpiCard).toList(),
    );
  }

  Widget _kpiCard(_Kpi k) {
    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.md12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: k.color.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            child: Icon(k.icon, size: 18, color: k.color),
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text(k.value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.text1)),
          Text(k.label, style: const TextStyle(fontSize: 12, color: AppColors.text2)),
        ],
      ),
    );
  }

  // ── Sales Overview chart (always renders the 12-month axis) ────
  Widget _salesChartCard(Map<String, dynamic> sc) {
    final labels = (sc['labels'] as List<dynamic>? ?? const []).map((e) => '$e').toList();
    final data = (sc['data'] as List<dynamic>? ?? const [])
        .map((e) => (e is num) ? e.toDouble() : double.tryParse('$e') ?? 0)
        .toList();
    final maxV = data.isEmpty ? 0.0 : data.reduce((a, b) => a > b ? a : b);
    final maxY = maxV <= 0 ? 1.0 : maxV * 1.25;
    final allZero = data.every((v) => v == 0);

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Sales Overview (last 12 months)',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          if (allZero)
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Text('No sales in the last 12 months for this company.', style: TextStyle(fontSize: 11, color: AppColors.text3)),
            ),
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
                            return Padding(padding: const EdgeInsets.only(top: 4), child: Text(labels[i], style: const TextStyle(fontSize: 8, color: AppColors.text3)));
                          },
                        ),
                      ),
                    ),
                    barGroups: [
                      for (var i = 0; i < data.length; i++)
                        BarChartGroupData(x: i, barRods: [
                          BarChartRodData(toY: allZero ? maxY * 0.02 : data[i], color: allZero ? AppColors.border : AppColors.primary, width: 9, borderRadius: const BorderRadius.vertical(top: Radius.circular(2))),
                        ]),
                    ],
                  )),
          ),
        ],
      ),
    );
  }

  // ── Tally Sync Status doughnut ─────────────────────────────────
  Widget _syncStatusCard(Map<String, dynamic> syc) {
    final labels = (syc['labels'] as List<dynamic>? ?? const ['Synced', 'Pending', 'Failed']).map((e) => '$e').toList();
    final data = (syc['data'] as List<dynamic>? ?? const [])
        .map((e) => (e is num) ? e.toDouble() : double.tryParse('$e') ?? 0)
        .toList();
    final total = data.fold<double>(0, (a, b) => a + b);
    final colors = [const Color(0xFF16A34A), const Color(0xFFD97706), const Color(0xFFDC2626)];

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Tally Sync Status', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.md12),
          if (total == 0)
            const Padding(padding: EdgeInsets.symmetric(vertical: AppSpacing.md12), child: Text('No sync activity yet.', style: TextStyle(color: AppColors.text3)))
          else
            Row(
              children: [
                SizedBox(
                  width: 120,
                  height: 120,
                  child: PieChart(PieChartData(
                    sectionsSpace: 2,
                    centerSpaceRadius: 32,
                    sections: [
                      for (var i = 0; i < data.length && i < 3; i++)
                        if (data[i] > 0)
                          PieChartSectionData(
                            value: data[i],
                            color: colors[i],
                            title: total > 0 ? '${(data[i] / total * 100).round()}%' : '',
                            radius: 26,
                            titleStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Colors.white),
                          ),
                    ],
                  )),
                ),
                const SizedBox(width: AppSpacing.lg16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (var i = 0; i < labels.length && i < 3; i++)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Container(width: 11, height: 11, decoration: BoxDecoration(color: colors[i], borderRadius: BorderRadius.circular(3))),
                              const SizedBox(width: 8),
                              Expanded(child: Text(labels[i], style: const TextStyle(fontSize: 13, color: AppColors.text2))),
                              Text(Fmt.num0(i < data.length ? data[i] : 0), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.text1)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  // ── Recent invoices ────────────────────────────────────────────
  Widget _recentInvoicesCard(List<dynamic> rows) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Recent Invoices', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.sm8),
          if (rows.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: AppSpacing.md12), child: Center(child: Text('No recent invoices.', style: TextStyle(color: AppColors.text3))))
          else
            ...rows.map((r) {
              final m = (r is Map) ? Map<String, dynamic>.from(r) : <String, dynamic>{};
              final total = (m['total'] is num) ? m['total'] as num : num.tryParse('${m['total']}') ?? 0;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${m['invoice_no'] ?? '-'}', style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                          Text('${m['customer'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                        ],
                      ),
                    ),
                    Text(Fmt.inr(total), style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  // ── Recent sync activity ───────────────────────────────────────
  Widget _recentSyncCard(List<dynamic> rows) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Recent Sync Activity', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.sm8),
          if (rows.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: AppSpacing.md12), child: Center(child: Text('No sync activity yet.', style: TextStyle(color: AppColors.text3))))
          else
            ...rows.map((r) {
              final m = (r is Map) ? Map<String, dynamic>.from(r) : <String, dynamic>{};
              final status = '${m['status'] ?? ''}';
              final color = status.toLowerCase().contains('fail')
                  ? const Color(0xFFDC2626)
                  : status.toLowerCase().contains('pend')
                      ? const Color(0xFFD97706)
                      : const Color(0xFF16A34A);
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Container(width: 9, height: 9, margin: const EdgeInsets.only(right: 10), decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3))),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${m['module'] ?? ''} ${m['record_type'] ?? ''}'.trim(), style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.text1)),
                          if (m['created_at'] != null)
                            Text(Fmt.dateTime(m['created_at']), style: const TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ),
                    Text(status, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: color)),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }
}

class _Kpi {
  const _Kpi(this.label, this.value, this.icon, this.color, this.module);
  final String label;
  final String value;
  final IconData icon;
  final Color color;
  final String? module;
}

/// Shown to a signed-in user whose role has NO Dashboard module — a friendly
/// welcome (with the notifications bell) instead of the KPI cards. Mirrors web.
class _WelcomeDashboard extends StatelessWidget {
  const _WelcomeDashboard({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        actions: [
          Consumer(builder: (_, r, __) {
            final unread = r.watch(notificationsUnreadProvider).maybeWhen(data: (n) => n, orElse: () => 0);
            return IconButton(
              icon: unread > 0
                  ? Badge(label: Text('$unread'), child: const Icon(Icons.notifications_outlined))
                  : const Icon(Icons.notifications_outlined),
              tooltip: 'Notifications',
              onPressed: () => context.push('/notifications'),
            );
          }),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.waving_hand_outlined, size: 48, color: AppColors.primary),
              const SizedBox(height: AppSpacing.md12),
              Text('Welcome, $name!',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: AppSpacing.sm8),
              Text('You\'re signed in. Use the menu to open the sections you have access to.',
                  textAlign: TextAlign.center, style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.text2)),
              const SizedBox(height: AppSpacing.sm8),
              Text('The KPI dashboard isn\'t part of your role — ask your administrator if you need it.',
                  textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
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
}
