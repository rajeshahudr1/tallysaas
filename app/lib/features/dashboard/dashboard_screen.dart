import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../notifications/notifications_screen.dart';
import '../field/field_dashboard_screen.dart';
import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/session.dart';
import '../../core/utils/date_ranges.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/user.dart';
import '../../shared/widgets/app_card.dart';

/// Dashboard — a mobile port of the WEB home page (web/views/dashboard/*),
/// panel for panel and in the same order:
///
///   1. Summary          — Cash / Bank / Inventory Amount / Payables,
///                         with the nine-preset date-range picker
///   2. Need Attention   — inactive customers & stock, missing contacts,
///                         overdue invoices (red-tinted panel)
///   3. Sales & Receipt  — totals, a grouped monthly bar chart, this-month
///                         figures with their vs-last-month deltas
///   4. Receivables      — ageing doughnut + legend + overdue / projections
///   5. Top 10           — six leaderboards behind one tab strip
///   6. Day Book         — one day's vouchers (Today / Yesterday / a date)
///   7. Recent Invoices + Recent Sync Activity
///
/// One request feeds all of it: GET /dashboard/summary?from&to[&daybook],
/// exactly as the web route does.
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  Future<Map<String, dynamic>>? _future;

  /// The selected Summary-panel preset (the web's ?range=). Defaults to the
  /// same This Year the web falls back to.
  String _rangeKey = DateRanges.defaultValue;

  /// The Day Book's day (ISO). Null → let the API pick today.
  String? _dayBookDate;

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

  /// One call, every panel — the same query string web/routes/web.js builds.
  Future<Map<String, dynamic>> _load() async {
    final range = DateRanges.resolve(_rangeKey, DateTime.now());
    final day = _dayBookDate != null ? '&daybook=$_dayBookDate' : '';
    final data = await ref
        .read(apiClientProvider)
        .get('${Endpoints.dashboardSummary}?from=${range.from}&to=${range.to}$day');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  void _setRange(String key) {
    if (key == _rangeKey) return;
    setState(() {
      _rangeKey = key;
      _future = _load();
    });
  }

  void _setDayBook(String iso) {
    if (iso == _dayBookDate) return;
    setState(() {
      _dayBookDate = iso;
      _future = _load();
    });
  }

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

    // Customer-portal login: a simple stats dashboard of THEIR data (assigned
    // categories/products + their own invoices) with tappable cards. Mirrors
    // the web portal dashboard; the API scopes every count to them.
    if (user != null && user.isCustomerUser) {
      return const _CustomerDashboard();
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
                final data = snap.data ?? const <String, dynamic>{};
                return RefreshIndicator(
                  onRefresh: () async => _refresh(),
                  child: ListView(
                    padding: const EdgeInsets.all(AppSpacing.md12),
                    children: [
                      _summaryPanel(data, user),
                      const SizedBox(height: AppSpacing.md12),
                      _attentionPanel(data, user),
                      const SizedBox(height: AppSpacing.md12),
                      _salesReceiptCard(data),
                      const SizedBox(height: AppSpacing.md12),
                      _receivablesCard(data),
                      const SizedBox(height: AppSpacing.md12),
                      _top10Card(data),
                      const SizedBox(height: AppSpacing.md12),
                      _dayBookCard(data),
                      const SizedBox(height: AppSpacing.md12),
                      _recentInvoicesCard(data['recent_invoices'] as List<dynamic>? ?? const []),
                      const SizedBox(height: AppSpacing.md12),
                      _recentSyncCard(data['recent_sync'] as List<dynamic>? ?? const []),
                      const SizedBox(height: AppSpacing.md12),
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

  // ── Formatting helpers ────────────────────────────────────────
  // The web prints whole rupees with Indian grouping (`₹43,19,793`) — NOT the
  // app's usual two-decimal Fmt.inr — so the two dashboards read identically.
  static final NumberFormat _grp = NumberFormat('#,##0', 'en_IN');

  static num _n(Object? v) => Fmt.n(v);
  static String _grouped(Object? v) => _grp.format(_n(v));
  static String _inr(Object? v) => '₹${_grp.format(_n(v))}';

  /// Ledger balances are signed (debit-positive). Print the magnitude with its
  /// Dr/Cr marker the way Tally does — a bare "₹-49,82,654" reads like a bug.
  static String _inrDc(Object? v) {
    final n = _n(v);
    if (n == 0) return _inr(0);
    return '${_inr(n.abs())} ${n > 0 ? 'Dr' : 'Cr'}';
  }

  static Map<String, dynamic> _map(Object? v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  static List<dynamic> _list(Object? v) => v is List ? v : const [];

  bool _can(AppUser? user, String? module) =>
      module == null || (user?.canModule(module) ?? true);

  // ── 1. Summary panel ──────────────────────────────────────────
  Widget _summaryPanel(Map<String, dynamic> data, AppUser? user) {
    final counts = _map(data['counts']);
    final balances = _map(data['balances']);

    final tiles = <_Tile>[
      _Tile(label: 'Cash', value: _inrDc(balances['cash']), route: '/cash'),
      _Tile(label: 'Bank', value: _inrDc(balances['bank']), route: '/bank'),
      _Tile(
        label: 'Inventory Amount',
        value: _inr(counts['stock_value']),
        route: '/inventory',
        module: 'inventory',
      ),
      _Tile(
        label: 'Payables',
        value: _inrDc(balances['payables']),
        route: '/payables',
        module: 'suppliers',
      ),
    ].where((t) => _can(user, t.module)).toList();

    if (tiles.isEmpty) return const SizedBox.shrink();

    return _Panel(
      title: 'Summary',
      // The range <select> lives in this panel's header on the web too.
      control: _RangePicker(value: _rangeKey, onChanged: _setRange),
      child: _TileGrid(tiles: tiles),
    );
  }

  // ── 2. Need Attention panel ───────────────────────────────────
  Widget _attentionPanel(Map<String, dynamic> data, AppUser? user) {
    final a = _map(data['attention']);

    final tiles = <_Tile>[
      _Tile(
        label: 'Inactive Customers',
        value: _grouped(a['inactive_customers']),
        route: '/customers',
        module: 'customers',
      ),
      _Tile(
        label: 'Inactive Stocks',
        value: _grouped(a['inactive_stocks']),
        route: '/inventory',
        module: 'products',
      ),
      _Tile(
        label: 'Payment Reminders',
        locked: true,
        sub: '${_grouped(a['missing_mobile'])} Mobile Missing · '
            '${_grouped(a['missing_email'])} Email Missing',
        route: '/customers',
        module: 'customers',
      ),
      _Tile(
        label: 'Overdue Invoices',
        value: _grouped(a['overdue_count']),
        sub: _inr(a['overdue_amount']),
        route: '/sales-invoices',
        module: 'sales-invoices',
      ),
    ].where((t) => _can(user, t.module)).toList();

    if (tiles.isEmpty) return const SizedBox.shrink();

    return _Panel(
      title: 'Need Attention',
      danger: true,
      child: _TileGrid(tiles: tiles),
    );
  }

  // ── 3. Sales & Receipt ────────────────────────────────────────
  Widget _salesReceiptCard(Map<String, dynamic> data) {
    final sr = _map(data['sales_receipt']);
    final labels = _list(sr['labels']).map((e) => '$e').toList();
    final sales = _list(sr['sales']).map((e) => _n(e).toDouble()).toList();
    final receipt = _list(sr['receipt']).map((e) => _n(e).toDouble()).toList();

    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const _CardTitle('Sales & Receipt'),
              // Same period control as the Summary panel, as on the web.
              Flexible(child: _RangePicker(value: _rangeKey, onChanged: _setRange)),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          Row(
            children: [
              Expanded(child: _Figure(label: 'Total Sales', value: _inr(sr['total_sales']))),
              Expanded(child: _Figure(label: 'Total Receipt', value: _inr(sr['total_receipt']))),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          SizedBox(
            height: 180,
            child: _groupedBars(labels, sales, receipt),
          ),
          const SizedBox(height: AppSpacing.sm8),
          const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _LegendDot(color: AppColors.primary, label: 'Sales'),
              SizedBox(width: AppSpacing.lg16),
              _LegendDot(color: Color(0xFF16A34A), label: 'Receipt'),
            ],
          ),
          const Divider(height: AppSpacing.xl24, color: AppColors.border),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: _FooterCell(
                  label: 'Sales This Month',
                  value: _inr(sr['sales_this_month']),
                  delta: _delta(sr['sales_change_pct']),
                ),
              ),
              Expanded(
                child: _FooterCell(
                  label: 'Receipt This Month',
                  value: _inr(sr['receipt_this_month']),
                  delta: _delta(sr['receipt_change_pct']),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// `change_pct` → the web's "12 % ↑ vs Last Month" caption, or null when the
  /// API has no previous month to compare against (never an invented 100%).
  static ({bool down, String text})? _delta(Object? v) {
    final n = (v is num) ? v.toDouble() : double.tryParse('$v');
    if (n == null || n.isNaN || n.isInfinite) return null;
    return (down: n < 0, text: '${n.abs().toStringAsFixed(0)} %');
  }

  Widget _groupedBars(List<String> labels, List<double> sales, List<double> receipt) {
    final len = [labels.length, sales.length, receipt.length]
        .reduce((a, b) => a < b ? a : b);
    if (len == 0) {
      return const Center(
        child: Text('No data available', style: TextStyle(color: AppColors.text3)),
      );
    }
    var maxV = 0.0;
    for (var i = 0; i < len; i++) {
      if (sales[i] > maxV) maxV = sales[i];
      if (receipt[i] > maxV) maxV = receipt[i];
    }
    final maxY = maxV <= 0 ? 1.0 : maxV * 1.2;

    return BarChart(
      BarChartData(
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
                if (i < 0 || i >= len) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(labels[i],
                      style: const TextStyle(fontSize: 8, color: AppColors.text3)),
                );
              },
            ),
          ),
        ),
        barGroups: [
          for (var i = 0; i < len; i++)
            BarChartGroupData(x: i, barsSpace: 2, barRods: [
              BarChartRodData(
                toY: sales[i],
                color: AppColors.primary,
                width: 6,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(2)),
              ),
              BarChartRodData(
                toY: receipt[i],
                color: const Color(0xFF16A34A),
                width: 6,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(2)),
              ),
            ]),
        ],
      ),
    );
  }

  // ── 4. Receivables ────────────────────────────────────────────
  /// Ageing band colours, oldest-last — the same list the web's doughnut and
  /// legend read, so a swatch always matches its arc.
  static const List<Color> _recvColors = [
    Color(0xFF6EE7B7), Color(0xFFF87171), Color(0xFFFB923C),
    Color(0xFFFCD34D), Color(0xFFA5B4FC), Color(0xFF60A5FA),
  ];

  Widget _receivablesCard(Map<String, dynamic> data) {
    final rv = _map(data['receivables']);
    final buckets = _list(rv['buckets']).map(_map).toList();
    final total = buckets.fold<double>(0, (a, b) => a + _n(b['amount']).toDouble());

    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const _CardTitle('Receivables'),
              _CardLink(label: 'View All', onTap: () => context.push('/receivables')),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          _Figure(label: 'Total Receivables', value: _inr(rv['total'])),
          const SizedBox(height: AppSpacing.md12),
          if (buckets.isEmpty || total <= 0)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md12),
              child: Text('No data available', style: TextStyle(color: AppColors.text3)),
            )
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                SizedBox(
                  width: 118,
                  height: 118,
                  child: PieChart(PieChartData(
                    sectionsSpace: 2,
                    centerSpaceRadius: 34,
                    sections: [
                      for (var i = 0; i < buckets.length; i++)
                        if (_n(buckets[i]['amount']) > 0)
                          PieChartSectionData(
                            value: _n(buckets[i]['amount']).toDouble(),
                            color: _recvColors[i % _recvColors.length],
                            title: '',
                            radius: 24,
                          ),
                    ],
                  )),
                ),
                const SizedBox(width: AppSpacing.md12),
                Expanded(
                  child: Column(
                    children: [
                      for (var i = 0; i < buckets.length; i++)
                        InkWell(
                          onTap: () => context.push('/receivables'),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 3),
                            child: Row(
                              children: [
                                Container(
                                  width: 10, height: 10,
                                  decoration: BoxDecoration(
                                    color: _recvColors[i % _recvColors.length],
                                    borderRadius: BorderRadius.circular(3),
                                  ),
                                ),
                                const SizedBox(width: AppSpacing.sm8),
                                Expanded(
                                  child: Text('${buckets[i]['label'] ?? ''}',
                                      style: const TextStyle(
                                          fontSize: 11.5, color: AppColors.text2)),
                                ),
                                Text(_inr(buckets[i]['amount']),
                                    style: const TextStyle(
                                        fontSize: 11.5,
                                        fontWeight: FontWeight.w700,
                                        color: AppColors.text1)),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          const Divider(height: AppSpacing.xl24, color: AppColors.border),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _FooterCell(label: 'Total Overdue', value: _inr(rv['overdue']))),
              Expanded(child: _FooterCell(label: 'In 15 Days', value: _inr(rv['projection_15']))),
              Expanded(child: _FooterCell(label: 'In 60 Days', value: _inr(rv['projection_60']))),
            ],
          ),
        ],
      ),
    );
  }

  // ── 5. Top 10 ─────────────────────────────────────────────────
  Widget _top10Card(Map<String, dynamic> data) {
    final t = _map(data['top10']);

    List<_TopRow> party(Object? rows, String route) => _list(rows).map(_map).map((r) {
          return _TopRow(
            name: '${r['name'] ?? ''}',
            value: '${_inr(r['value'])} ${r['dc'] ?? ''}'.trim(),
            route: route,
          );
        }).toList();

    List<_TopRow> item(Object? rows, {required bool withQty}) =>
        _list(rows).map(_map).map((r) {
          return _TopRow(
            name: '${r['name'] ?? ''}',
            value: _inr(r['value']),
            qty: withQty ? _grouped(r['qty']) : null,
            route: '/products',
          );
        }).toList();

    final tabs = <_TopTab>[
      _TopTab('Customers', party(t['customers'], '/customers')),
      _TopTab('Suppliers', party(t['suppliers'], '/suppliers')),
      _TopTab('Items Sold By Quantity', item(t['items_sold_qty'], withQty: true)),
      _TopTab('Items Sold By Value', item(t['items_sold_value'], withQty: false)),
      _TopTab('Items Purchased By Quantity', item(t['items_purchased_qty'], withQty: true)),
      _TopTab('Items Purchased By Value', item(t['items_purchased_value'], withQty: false)),
    ];

    return _Top10Panel(tabs: tabs);
  }

  // ── 6. Day Book ───────────────────────────────────────────────
  Widget _dayBookCard(Map<String, dynamic> data) {
    final now = DateTime.now();
    final todayIso = DateRanges.iso(now);
    final yesterdayIso = DateRanges.iso(DateTime(now.year, now.month, now.day - 1));
    final bookDate = '${data['day_book_date'] ?? ''}'.isNotEmpty
        ? '${data['day_book_date']}'
        : (_dayBookDate ?? todayIso);
    final rows = _list(data['day_book']).map(_map).toList();

    // Each voucher links to its module's list — the only drill-down every
    // voucher kind actually has (same map as the web).
    const voucherRoute = {
      'sales-invoice': '/sales-invoices',
      'purchase-invoice': '/purchase-invoices',
      'payment': '/payments',
      'journal': '/journals',
    };

    String dayLabel(String iso) {
      final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(iso);
      return m == null ? 'Custom Date' : '${m[3]}/${m[2]}/${m[1]}';
    }

    Future<void> pickDay() async {
      final parsed = DateTime.tryParse(bookDate) ?? now;
      final picked = await showDatePicker(
        context: context,
        initialDate: parsed,
        firstDate: DateTime(now.year - 5),
        lastDate: DateTime(now.year + 1, 12, 31),
      );
      if (picked != null) _setDayBook(DateRanges.iso(picked));
    }

    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _CardTitle('Day Book'),
          const SizedBox(height: AppSpacing.sm8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _Pill(
                  label: 'Today',
                  active: bookDate == todayIso,
                  onTap: () => _setDayBook(todayIso),
                ),
                const SizedBox(width: AppSpacing.sm8),
                _Pill(
                  label: 'Yesterday',
                  active: bookDate == yesterdayIso,
                  onTap: () => _setDayBook(yesterdayIso),
                ),
                const SizedBox(width: AppSpacing.sm8),
                _Pill(
                  label: (bookDate != todayIso && bookDate != yesterdayIso)
                      ? dayLabel(bookDate)
                      : 'Custom Date',
                  icon: Icons.calendar_today_outlined,
                  active: bookDate != todayIso && bookDate != yesterdayIso,
                  onTap: pickDay,
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md12),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md12),
              child: Text('No data available', style: TextStyle(color: AppColors.text3)),
            )
          else
            ...rows.map((r) {
              final route = voucherRoute['${r['kind']}'] ?? '/sales-invoices';
              return InkWell(
                onTap: () => context.push(route),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${r['voucher_no'] ?? ''}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600,
                                    fontSize: 13,
                                    color: AppColors.primary)),
                            Text('${r['particulars'] ?? ''}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                            Text('${r['type'] ?? ''}',
                                style: const TextStyle(fontSize: 11, color: AppColors.text3)),
                          ],
                        ),
                      ),
                      Text(_inr(r['amount']),
                          style: const TextStyle(
                              fontWeight: FontWeight.w700, color: AppColors.text1)),
                    ],
                  ),
                ),
              );
            }),
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

  // ── 7. Recent invoices ─────────────────────────────────────────
  Widget _recentInvoicesCard(List<dynamic> rows) {
    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const _CardTitle('Recent Invoices'),
              _CardLink(label: 'View all', onTap: () => context.push('/sales-invoices')),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md12),
              child: Text('No data available', style: TextStyle(color: AppColors.text3)),
            )
          else
            ...rows.map((r) {
              final m = _map(r);
              return InkWell(
                onTap: () => context.push('/sales-invoices'),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${m['invoice_no'] ?? '-'}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600, color: AppColors.text1)),
                            Text('${m['customer'] ?? ''}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(_inr(m['total']),
                              style: const TextStyle(
                                  fontWeight: FontWeight.w700, color: AppColors.text1)),
                          if ('${m['invoice_date'] ?? ''}'.isNotEmpty)
                            Text(Fmt.date(m['invoice_date']),
                                style: const TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }

  // ── 8. Recent sync activity ────────────────────────────────────
  Widget _recentSyncCard(List<dynamic> rows) {
    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const _CardTitle('Recent Sync Activity'),
              _CardLink(label: 'View logs', onTap: () => context.push('/sync-logs')),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md12),
              child: Text('No data available', style: TextStyle(color: AppColors.text3)),
            )
          else
            ...rows.map((r) {
              final m = _map(r);
              final status = '${m['status'] ?? ''}';
              final lower = status.toLowerCase();
              final color = lower.contains('fail')
                  ? const Color(0xFFDC2626)
                  : lower.contains('pend')
                      ? const Color(0xFFD97706)
                      : const Color(0xFF16A34A);
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Container(
                      width: 9, height: 9,
                      margin: const EdgeInsets.only(right: 10),
                      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(5)),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${m['module'] ?? ''} ${m['record_type'] ?? ''}'.trim(),
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.text1)),
                          if (m['created_at'] != null)
                            Text(Fmt.dateTime(m['created_at']),
                                style: const TextStyle(fontSize: 11, color: AppColors.text3)),
                        ],
                      ),
                    ),
                    Text(status,
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: color)),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Panel building blocks — the Flutter twins of the web's
// partials/kpi-panel.ejs and the .chart-card / .recent-card classes.
// ═══════════════════════════════════════════════════════════════

/// A titled panel holding a grid of metric tiles. `danger` tints the header
/// red, the way `.kpi-panel--danger` does on the web (Need Attention).
class _Panel extends StatelessWidget {
  const _Panel({
    required this.title,
    required this.child,
    this.control,
    this.danger = false,
  });

  final String title;
  final Widget child;
  final Widget? control;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final headFg = danger ? const Color(0xFFB91C1C) : AppColors.text1;
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: danger ? const Color(0xFFFEF2F2) : const Color(0xFFF8FAFC),
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.lg16, vertical: AppSpacing.md12),
            child: Row(
              children: [
                if (danger) ...[
                  Icon(Icons.error_outline, size: 16, color: headFg),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: Text(title,
                      style: TextStyle(
                          fontSize: 14, fontWeight: FontWeight.w700, color: headFg)),
                ),
                if (control != null) Flexible(child: control!),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: child,
          ),
        ],
      ),
    );
  }
}

/// One metric tile inside a panel.
class _Tile {
  const _Tile({
    required this.label,
    this.value,
    this.sub,
    this.route,
    this.module,
    this.locked = false,
  });

  final String label;
  final String? value;
  final String? sub;
  final String? route;

  /// The module permission this tile's target needs — a user who cannot view
  /// it never sees the tile (same gating as the web).
  final String? module;

  /// Renders the little padlock the web puts on "Payment Reminders".
  final bool locked;
}

/// The web's 2×2 `.kpi-tiles` grid.
class _TileGrid extends StatelessWidget {
  const _TileGrid({required this.tiles});
  final List<_Tile> tiles;

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: AppSpacing.sm8,
      crossAxisSpacing: AppSpacing.sm8,
      childAspectRatio: 1.5,
      children: tiles.map((t) {
        final body = Padding(
          padding: const EdgeInsets.all(AppSpacing.md12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(t.label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                  ),
                  if (t.locked)
                    const Padding(
                      padding: EdgeInsets.only(left: 4),
                      child: Icon(Icons.lock_outline, size: 11, color: AppColors.text3),
                    ),
                  if (t.route != null)
                    const Icon(Icons.chevron_right, size: 14, color: AppColors.text3),
                ],
              ),
              const SizedBox(height: 6),
              if (t.value != null)
                Text(t.value!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 15.5, fontWeight: FontWeight.w700, color: AppColors.text1)),
              if (t.sub != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(t.sub!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10.5, color: AppColors.text3)),
                ),
            ],
          ),
        );
        return Material(
          color: AppColors.scaffoldBg,
          borderRadius: BorderRadius.circular(AppRadius.sm8 + 2),
          clipBehavior: Clip.antiAlias,
          child: t.route == null
              ? body
              : InkWell(onTap: () => context.push(t.route!), child: body),
        );
      }).toList(),
    );
  }
}

/// The nine-preset date-range picker — the web's `.kpi-panel-select`.
class _RangePicker extends StatelessWidget {
  const _RangePicker({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final ranges = DateRanges.build(DateTime.now());
    return PopupMenuButton<String>(
      initialValue: value,
      tooltip: 'Date range',
      onSelected: onChanged,
      itemBuilder: (_) => [
        for (final r in ranges)
          PopupMenuItem<String>(
            value: r.value,
            child: Text(r.label, style: const TextStyle(fontSize: 13)),
          ),
      ],
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.card,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.sm8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                // The full label carries the dates too; in the app's narrow
                // header show just the period NAME and keep the dates for the
                // menu, where there is room for them.
                ranges.firstWhere((r) => r.value == value,
                    orElse: () => ranges.first).label.split(' (').first,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.text2),
              ),
            ),
            const Icon(Icons.expand_more, size: 16, color: AppColors.text3),
          ],
        ),
      ),
    );
  }
}

class _CardTitle extends StatelessWidget {
  const _CardTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(
          fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1));
}

class _CardLink extends StatelessWidget {
  const _CardLink({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Text(label,
            style: const TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.primary)),
      );
}

/// A big headline figure with its caption — the web's `.sr-figure`.
class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.text2)),
          const SizedBox(height: 2),
          Text(value,
              style: const TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w800, color: AppColors.text1)),
        ],
      );
}

/// A panel-footer cell with an optional up/down delta — `.sr-footer-cell`.
class _FooterCell extends StatelessWidget {
  const _FooterCell({required this.label, required this.value, this.delta});
  final String label;
  final String value;
  final ({bool down, String text})? delta;

  @override
  Widget build(BuildContext context) {
    final d = delta;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            maxLines: 2,
            style: const TextStyle(fontSize: 11, color: AppColors.text2)),
        const SizedBox(height: 2),
        Text(value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.text1)),
        if (d != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              children: [
                Icon(d.down ? Icons.arrow_downward : Icons.arrow_upward,
                    size: 11,
                    color: d.down ? const Color(0xFFDC2626) : const Color(0xFF16A34A)),
                const SizedBox(width: 2),
                Flexible(
                  child: Text('${d.text} vs Last Month',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 10,
                          color: d.down ? const Color(0xFFDC2626) : const Color(0xFF16A34A))),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _LegendDot extends StatelessWidget {
  const _LegendDot({required this.color, required this.label});
  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 10, height: 10,
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
          ),
          const SizedBox(width: 6),
          Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.text2)),
        ],
      );
}

/// A Day Book control pill — `.daybook-pill`.
class _Pill extends StatelessWidget {
  const _Pill({
    required this.label,
    required this.active,
    required this.onTap,
    this.icon,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.pill999),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: active ? AppColors.primaryTint : AppColors.card,
          border: Border.all(color: active ? AppColors.primary : AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.pill999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 13, color: active ? AppColors.primary : AppColors.text2),
              const SizedBox(width: 5),
            ],
            Text(label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: active ? AppColors.primary : AppColors.text2,
                )),
          ],
        ),
      ),
    );
  }
}

// ── Top 10 ──────────────────────────────────────────────────────

class _TopRow {
  const _TopRow({required this.name, required this.value, this.qty, this.route});
  final String name;
  final String value;
  final String? qty;
  final String? route;
}

class _TopTab {
  const _TopTab(this.label, this.rows);
  final String label;
  final List<_TopRow> rows;
}

/// The Top 10 panel. All six datasets ship together and the tab strip switches
/// between them purely client-side, so changing tab costs no request — exactly
/// as on the web.
class _Top10Panel extends StatefulWidget {
  const _Top10Panel({required this.tabs});
  final List<_TopTab> tabs;

  @override
  State<_Top10Panel> createState() => _Top10PanelState();
}

class _Top10PanelState extends State<_Top10Panel> {
  int _active = 0;

  @override
  Widget build(BuildContext context) {
    final tabs = widget.tabs;
    if (tabs.isEmpty) return const SizedBox.shrink();
    final active = tabs[_active.clamp(0, tabs.length - 1)];

    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _CardTitle('Top 10'),
          const SizedBox(height: AppSpacing.sm8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (var i = 0; i < tabs.length; i++) ...[
                  _Pill(
                    label: tabs[i].label,
                    active: i == _active,
                    onTap: () => setState(() => _active = i),
                  ),
                  if (i != tabs.length - 1) const SizedBox(width: AppSpacing.sm8),
                ],
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md12),
          if (active.rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.md12),
              child: Text('No data available', style: TextStyle(color: AppColors.text3)),
            )
          else
            for (var i = 0; i < active.rows.length; i++)
              _topRow(context, i, active.rows[i]),
        ],
      ),
    );
  }

  Widget _topRow(BuildContext context, int idx, _TopRow row) {
    // The first three ranks get the web's medal treatment.
    const medals = [Color(0xFFD4AF37), Color(0xFF9CA3AF), Color(0xFFB45309)];
    final body = Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          SizedBox(
            width: 24,
            child: idx < 3
                ? Icon(Icons.workspace_premium, size: 16, color: medals[idx])
                : Text('${idx + 1}',
                    style: const TextStyle(fontSize: 12, color: AppColors.text3)),
          ),
          Expanded(
            child: Text(row.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13, color: AppColors.text1)),
          ),
          if (row.qty != null)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.sm8),
              child: Text('${row.qty} qty',
                  style: const TextStyle(fontSize: 11, color: AppColors.text3)),
            ),
          Text(row.value,
              style: const TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.text1)),
        ],
      ),
    );
    return row.route == null
        ? body
        : InkWell(onTap: () => context.push(row.route!), child: body);
  }
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

/// Customer-portal dashboard — simple, tappable stat cards of THE CUSTOMER'S
/// OWN data (assigned categories/products + their invoices). Counts come from
/// the API-scoped list metas, so they always match what the customer may see:
///   My Categories / My Products      — list meta.total (catalog-scoped)
///   My Invoices / Invoice Amount     — ?approval=all meta.total / grand_total
///   Pending / Approved               — ?approval=pending|approved meta.total
/// Mirrors the web portal dashboard (cards navigate to the same screens).
class _CustomerDashboard extends ConsumerStatefulWidget {
  const _CustomerDashboard();

  @override
  ConsumerState<_CustomerDashboard> createState() => _CustomerDashboardState();
}

class _CustomerDashboardState extends ConsumerState<_CustomerDashboard> {
  late Future<List<({num total, num amount})>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<({num total, num amount})> _meta(String path) async {
    try {
      final data = await ref.read(apiClientProvider).get(path);
      final m = (data is Map && data['meta'] is Map) ? data['meta'] as Map : const {};
      num n(Object? v) => v is num ? v : (num.tryParse('$v') ?? 0);
      return (total: n(m['total']), amount: n(m['grand_total']));
    } catch (_) {
      return (total: 0, amount: 0); // best-effort card; never breaks the page
    }
  }

  Future<List<({num total, num amount})>> _load() => Future.wait([
        _meta('/categories?per_page=1'),
        _meta('/products?per_page=1'),
        _meta('/sales-invoices?per_page=1&approval=all'),
        _meta('/sales-invoices?per_page=1&approval=pending'),
        _meta('/sales-invoices?per_page=1&approval=approved'),
      ]);

  void _refresh() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
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
      body: FutureBuilder<List<({num total, num amount})>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return _ErrorView(message: 'Could not load your dashboard.', onRetry: _refresh);
          }
          final d = snap.data ?? const <({num total, num amount})>[];
          ({num total, num amount}) at(int i) =>
              i < d.length ? d[i] : (total: 0, amount: 0);
          final cards = <({String label, String value, IconData icon, Color color, String route})>[
            (label: 'My Categories',     value: Fmt.num0(at(0).total),  icon: Icons.category_outlined,     color: const Color(0xFF7C3AED), route: '/categories'),
            (label: 'My Products',       value: Fmt.num0(at(1).total),  icon: Icons.inventory_2_outlined,  color: const Color(0xFF0D9488), route: '/products'),
            (label: 'My Invoices',       value: Fmt.num0(at(2).total),  icon: Icons.receipt_long_outlined, color: const Color(0xFF2563EB), route: '/sales-invoices'),
            (label: 'Invoice Amount',    value: Fmt.inr(at(2).amount),  icon: Icons.currency_rupee,        color: const Color(0xFF4F46E5), route: '/sales-invoices'),
            (label: 'Pending Invoices',  value: Fmt.num0(at(3).total),  icon: Icons.hourglass_top,         color: const Color(0xFFD97706), route: '/sales-invoices'),
            (label: 'Approved Invoices', value: Fmt.num0(at(4).total),  icon: Icons.check_circle_outline,  color: const Color(0xFF16A34A), route: '/sales-invoices'),
          ];
          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: GridView.count(
              padding: const EdgeInsets.all(AppSpacing.md12),
              crossAxisCount: 2,
              mainAxisSpacing: AppSpacing.sm8,
              crossAxisSpacing: AppSpacing.sm8,
              childAspectRatio: 1.45,
              children: [
                for (final k in cards)
                  AppCard(
                    padding: const EdgeInsets.all(AppSpacing.md12),
                    onTap: () => context.push(k.route),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Container(
                          width: 34, height: 34,
                          decoration: BoxDecoration(
                            color: k.color.withOpacity(0.12),
                            borderRadius: BorderRadius.circular(AppRadius.sm8),
                          ),
                          child: Icon(k.icon, size: 18, color: k.color),
                        ),
                        const SizedBox(height: AppSpacing.sm8),
                        Text(k.value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.text1)),
                        Text(k.label, style: const TextStyle(fontSize: 12, color: AppColors.text2)),
                      ],
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
