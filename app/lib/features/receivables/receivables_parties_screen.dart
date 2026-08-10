import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// The overdue windows the Receivables list filters by. These measure days
/// PAST DUE, which is a different question from the dashboard's ageing
/// buckets (days since the invoice date) — keep the two apart.
const _recvFilters = <MapEntry<String, String>>[
  MapEntry('all', 'All'),
  MapEntry('due_today', 'Due Today'),
  MapEntry('not_due', 'Not Due'),
  MapEntry('1-30', '1-30'),
  MapEntry('31-60', '31-60'),
  MapEntry('61-120', '61-120'),
  MapEntry('>120', '>120'),
];

const _recvSorts = <MapEntry<String, String>>[
  MapEntry('outstanding', 'Highest Outstanding'),
  MapEntry('overdue', 'Highest Overdue'),
  MapEntry('avg_pay_days', 'Slowest Payers'),
  MapEntry('name', 'Name (A–Z)'),
];

/// Receivables — party-wise. One row per customer with Outstanding, Overdue,
/// Credit Days and Avg Pay Days, mirroring the web screen. Tapping a party
/// opens their bill-wise outstanding.
class ReceivablesPartiesScreen extends ConsumerStatefulWidget {
  const ReceivablesPartiesScreen({super.key, this.payable = false});

  /// Payables is the same screen with the sides swapped: open PURCHASE bills
  /// settled by payments to suppliers. Only the endpoint, the title and the
  /// reminder action differ, so the two share one widget.
  final bool payable;

  @override
  ConsumerState<ReceivablesPartiesScreen> createState() => _ReceivablesPartiesScreenState();
}

class _ReceivablesPartiesScreenState extends ConsumerState<ReceivablesPartiesScreen> {
  Future<Map<String, dynamic>>? _future;
  String _filter = 'all';
  String _sort = 'outstanding';
  String? _group;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final q = <String, dynamic>{'filter': _filter, 'sort': _sort, 'per_page': 100};
    if (_group != null && _group!.isNotEmpty) q['group'] = _group;
    if (_search.trim().isNotEmpty) q['search'] = _search.trim();
    final base = widget.payable ? '/payables' : '/receivables';
    final data = await ref.read(apiClientProvider).get('$base/parties', query: q);
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.payable ? 'Payables' : 'Receivables'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh)],
      ),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return _retry(
                widget.payable ? 'Could not load payables.' : 'Could not load receivables.',
                _refresh);
          }
          final body = snap.data ?? const {};
          final rows = (body['data'] as List<dynamic>? ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
          final meta = body['meta'] as Map<String, dynamic>? ?? const {};
          final groups = (meta['groups'] as List<dynamic>? ?? const []).map((e) => '$e').toList();
          final missing = _n(meta['missing_contact']);

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md12),
              children: [
                if (missing > 0) _missingContactBanner(missing),
                _totals(meta),
                const SizedBox(height: AppSpacing.md12),
                _filterChips(),
                const SizedBox(height: AppSpacing.sm8),
                _controls(groups),
                const SizedBox(height: AppSpacing.md12),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(child: Text('No parties with an outstanding balance.',
                        style: TextStyle(color: AppColors.text3))),
                  )
                else
                  ...rows.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _partyRow(r),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  /// A null credit period / pay history means "not known", not "zero" — a dash
  /// keeps an unmeasured column from reading as a real measured value.
  String _days(Object? v) => v == null ? '—' : '${Fmt.num0(v)} days';

  Widget _missingContactBanner(num n) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: const Color(0xFFFFFBEB),
          border: Border.all(color: const Color(0xFFFDE68A)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            const Icon(Icons.warning_amber_rounded, color: Color(0xFFB45309), size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text('$n parties missing contact details',
                  style: const TextStyle(fontSize: 12.5, color: Color(0xFF92400E))),
            ),
          ],
        ),
      ),
    );
  }

  Widget _totals(Map<String, dynamic> meta) {
    return Row(
      children: [
        Expanded(child: _totalCard(
            widget.payable ? 'Total Due' : 'Total Outstanding',
            Fmt.inr(_n(meta['total_outstanding'])), true)),
        const SizedBox(width: AppSpacing.sm8),
        Expanded(child: _totalCard('Total Overdue', Fmt.inr(_n(meta['total_overdue'])), false)),
      ],
    );
  }

  Widget _totalCard(String label, String value, bool primary) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.text2)),
          const SizedBox(height: 2),
          Text(value,
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w800,
                color: primary ? AppColors.text1 : const Color(0xFFB91C1C),
              )),
        ],
      ),
    );
  }

  Widget _filterChips() {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final f in _recvFilters) ...[
            ChoiceChip(
              label: Text(f.value),
              selected: _filter == f.key,
              onSelected: (_) {
                if (_filter == f.key) return;
                setState(() {
                  _filter = f.key;
                  _future = _load();
                });
              },
              labelStyle: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: _filter == f.key ? Colors.white : AppColors.text2,
              ),
              selectedColor: AppColors.primary,
              backgroundColor: Colors.white,
              showCheckmark: false,
            ),
            const SizedBox(width: AppSpacing.sm8),
          ],
        ],
      ),
    );
  }

  Widget _controls(List<String> groups) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            decoration: const InputDecoration(
              isDense: true,
              prefixIcon: Icon(Icons.search, size: 18),
              hintText: 'Search party',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (v) => setState(() {
              _search = v;
              _future = _load();
            }),
          ),
        ),
        const SizedBox(width: AppSpacing.sm8),
        PopupMenuButton<String>(
          tooltip: 'Sort',
          icon: const Icon(Icons.sort),
          onSelected: (v) => setState(() {
            _sort = v;
            _future = _load();
          }),
          itemBuilder: (_) => [
            for (final s in _recvSorts)
              PopupMenuItem(value: s.key, child: Text(s.value)),
          ],
        ),
        if (groups.isNotEmpty)
          PopupMenuButton<String>(
            tooltip: 'Ledger group',
            icon: Icon(Icons.filter_alt,
                color: (_group != null && _group!.isNotEmpty) ? AppColors.primary : null),
            onSelected: (v) => setState(() {
              _group = v.isEmpty ? null : v;
              _future = _load();
            }),
            itemBuilder: (_) => [
              const PopupMenuItem(value: '', child: Text('All Receivables')),
              for (final g in groups) PopupMenuItem(value: g, child: Text(g)),
            ],
          ),
      ],
    );
  }

  Widget _partyRow(Map<String, dynamic> r) {
    final overdue = _n(r['overdue']);
    return AppCard(
      onTap: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ReceivablesPartyBillsScreen(
          customerId: _n(r['party_id'] ?? r['customer_id']).toInt(),
          name: '${r['name'] ?? ''}',
          payable: widget.payable,
        ),
      )),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${r['name'] ?? ''}',
                        style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
                    if (r['ledger_group'] != null)
                      Text('${r['ledger_group']}',
                          style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(Fmt.inr(_n(r['outstanding'])),
                      style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                  if (overdue > 0)
                    Text('${Fmt.inr(overdue)} overdue',
                        style: const TextStyle(fontSize: 11.5, color: Color(0xFFB91C1C))),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              _meta('Credit', _days(r['credit_days'])),
              const SizedBox(width: AppSpacing.md12),
              _meta('Avg Pay', _days(r['avg_pay_days'])),
              const SizedBox(width: AppSpacing.md12),
              _meta('Bills', Fmt.num0(_n(r['bills']))),
            ],
          ),
        ],
      ),
    );
  }

  Widget _meta(String label, String value) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('$label ', style: const TextStyle(fontSize: 11, color: AppColors.text3)),
        Text(value, style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.text2)),
      ],
    );
  }
}

/// One party's OPEN bills: Voucher No, Reference No, Date, Due Days, Due Date,
/// Amount — plus the On Account figure (receipt money that matched no bill,
/// shown beside the total rather than netted into it).
class ReceivablesPartyBillsScreen extends ConsumerStatefulWidget {
  const ReceivablesPartyBillsScreen({
    super.key,
    required this.customerId,
    required this.name,
    this.payable = false,
  });
  final int customerId;
  final String name;

  /// Payables side — open PURCHASE bills settled by payments to a supplier.
  final bool payable;

  @override
  ConsumerState<ReceivablesPartyBillsScreen> createState() => _ReceivablesPartyBillsScreenState();
}

class _ReceivablesPartyBillsScreenState extends ConsumerState<ReceivablesPartyBillsScreen> {
  Future<Map<String, dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final base = widget.payable ? '/payables' : '/receivables';
    final data = await ref.read(apiClientProvider).get('$base/parties/${widget.customerId}/bills');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  num _n(Object? v) => (v is num) ? v : num.tryParse('$v') ?? 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.name)),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) return _retry('Could not load bills.', _refresh);

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
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Total Outstanding',
                                style: TextStyle(fontSize: 11.5, color: AppColors.text2)),
                            Text(Fmt.inr(_n(meta['total_outstanding'])),
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: AppColors.text1)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          const Text('On Account', style: TextStyle(fontSize: 11.5, color: AppColors.text2)),
                          Text(Fmt.inr(_n(meta['on_account'])),
                              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.md12),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                    child: Center(child: Text('No open bills — every invoice is settled.',
                        style: TextStyle(color: AppColors.text3))),
                  )
                else
                  ...rows.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _billRow(r),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _billRow(Map<String, dynamic> r) {
    final dd = r['due_days'];
    // Positive = days PAST due; negative = still inside its terms.
    final overdue = dd is num && dd > 0;
    final dueText = dd == null
        ? '—'
        : (dd as num) > 0
            ? '$dd days overdue'
            : dd == 0
                ? 'Due today'
                : '${-dd} days to go';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('${r['voucher_no'] ?? ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
              ),
              // Money owed TO us is a debit on the party; money we owe THEM is
              // a credit — the marker follows the side, not the screen.
              Text('${Fmt.inr(_n(r['amount']))} ${widget.payable ? 'Cr' : 'Dr'}',
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Ref ${r['reference_no'] ?? '-'} · ${Fmt.date(r['date'])}'
                  '${r['due_date'] != null ? ' · Due ${Fmt.date(r['due_date'])}' : ''}',
                  style: const TextStyle(fontSize: 11.5, color: AppColors.text3),
                ),
              ),
              Text(dueText,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: overdue ? const Color(0xFFB91C1C) : AppColors.text2,
                  )),
            ],
          ),
        ],
      ),
    );
  }
}

Widget _retry(String message, VoidCallback onRetry) {
  return Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(message, style: const TextStyle(color: AppColors.text2)),
        const SizedBox(height: AppSpacing.sm8),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}
