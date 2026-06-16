import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/endpoints.dart';
import '../../core/utils/formatters.dart';
import '../../data/repositories/report_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Which report shape a [ReportViewScreen] should render. The `/reports/*`
/// endpoints return heterogeneous payloads, so the viewer branches on this
/// rather than trying to coerce them all into one table.
enum ReportKind {
  /// `{ summary{count,total_taxable,total_gst,total_amount}, data[{date,
  /// invoice_no,customer,gstin,taxable,cgst,sgst,total,status}], meta }`.
  salesRegister,

  /// `{ summary{count,sales,purchase,receipts,payments}, data[{date,vch_type,
  /// vch_no,party,amount}], meta }`.
  dayBook,

  /// `{ type, summary{count,total_outstanding}, data[{party,gstin,opening,
  /// invoiced,settled,balance}], meta }` — receivable or payable.
  outstanding,

  /// `{ summary{skus,total_qty,total_value,low,out}, data[{name,category,unit,
  /// qty,rate,value,status}], meta }`.
  stockSummary,

  /// `{ data[{ledger,debit,credit}], totals{debit,credit} }`.
  trialBalance,

  /// `{ outward{count,taxable,cgst,sgst,igst,tax}, inward{…}, net_payable }`.
  gstSummary,

  /// `{ left[{label,amount}], right[…], left_total, right_total, gross_profit,
  /// sales, purchases }` — Expenses | Income two-column.
  profitLoss,

  /// `{ liabilities[{label,amount}], assets[…], liab_total, asset_total }`.
  balanceSheet,

  /// `{ party{name,gstin,type}, opening, closing, totals{debit,credit},
  /// data[{date,vtype,ref,debit,credit,balance}] }` — needs a party first.
  ledger,
}

/// A single Tally-style report viewer driven by [kind]. Handles three broad
/// families:
///   • tables   — sales register, day book, outstanding, stock, trial balance
///   • summaries — GST summary, P&L, balance sheet (labelled amount sections)
///   • ledger    — a party account statement (picks a party first)
///
/// Date-range reports ([dateRange]=true) show From/To pickers defaulting to the
/// current month and refetch on change. The ledger ([needsParty]=true) shows a
/// customer picker before loading. `outstanding` passes its receivable/payable
/// via [extraQuery].
class ReportViewScreen extends ConsumerStatefulWidget {
  const ReportViewScreen({
    super.key,
    required this.title,
    required this.endpoint,
    required this.kind,
    this.dateRange = false,
    this.needsParty = false,
    this.extraQuery = const {},
  });

  final String title;
  final String endpoint;
  final ReportKind kind;

  /// Show From/To date pickers (sales-register, day-book, gst-summary).
  final bool dateRange;

  /// Require a party selection before fetching (ledger).
  final bool needsParty;

  /// Static query params baked into every request (e.g. outstanding `type`).
  final Map<String, dynamic> extraQuery;

  @override
  ConsumerState<ReportViewScreen> createState() => _ReportViewScreenState();
}

class _ReportViewScreenState extends ConsumerState<ReportViewScreen> {
  late DateTime _from;
  late DateTime _to;
  int? _partyId;

  // Bumped to force a refetch when filters change (FutureBuilder keys off it).
  int _reloadToken = 0;
  Future<Map<String, dynamic>>? _future;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _from = DateTime(now.year, now.month, 1);
    _to = DateTime(now.year, now.month + 1, 0); // last day of this month
    // Ledger waits for a party; everything else loads immediately.
    if (!widget.needsParty) _future = _load();
  }

  String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  Future<Map<String, dynamic>> _load() {
    final query = <String, dynamic>{...widget.extraQuery};
    if (widget.dateRange) {
      query['date_from'] = _ymd(_from);
      query['date_to'] = _ymd(_to);
      query['per_page'] = 100; // registers: show the whole filtered set
    }
    if (widget.needsParty && _partyId != null) {
      query['party_type'] = 'customer';
      query['party_id'] = _partyId;
    }
    return ref.read(reportRepositoryProvider).fetch(
          widget.endpoint,
          query: query,
        );
  }

  void _refresh() {
    setState(() {
      _reloadToken++;
      _future = _load();
    });
  }

  Future<void> _pickDate({required bool isFrom}) async {
    final initial = isFrom ? _from : _to;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (isFrom) {
        _from = picked;
        if (_to.isBefore(_from)) _to = _from;
      } else {
        _to = picked;
        if (_from.isAfter(_to)) _from = _to;
      }
    });
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          if (widget.dateRange) _dateBar(),
          if (widget.needsParty) _partyBar(),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  // ── Filter bars ────────────────────────────────────────────────

  Widget _dateBar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md12, AppSpacing.sm8, AppSpacing.md12, AppSpacing.sm8,
      ),
      decoration: const BoxDecoration(
        color: AppColors.card,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Expanded(child: _DateChip(label: 'From', value: Fmt.date(_from), onTap: () => _pickDate(isFrom: true))),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(child: _DateChip(label: 'To', value: Fmt.date(_to), onTap: () => _pickDate(isFrom: false))),
        ],
      ),
    );
  }

  Widget _partyBar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md12, AppSpacing.sm8, AppSpacing.md12, AppSpacing.md12,
      ),
      decoration: const BoxDecoration(
        color: AppColors.card,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: FkDropdown(
        label: 'Party (Customer)',
        endpoint: Endpoints.customers,
        value: _partyId,
        onChanged: (v) {
          setState(() => _partyId = v);
          if (v != null) _refresh();
        },
      ),
    );
  }

  // ── Body / async state ─────────────────────────────────────────

  Widget _body() {
    if (widget.needsParty && _partyId == null) {
      return const EmptyState(
        'Select a party to view its ledger.',
        icon: Icons.account_balance_wallet_outlined,
      );
    }
    return FutureBuilder<Map<String, dynamic>>(
      key: ValueKey(_reloadToken),
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const LoadingState(message: 'Loading report…');
        }
        if (snap.hasError) {
          return ErrorState(snap.error.toString(), onRetry: _refresh);
        }
        final data = snap.data ?? const <String, dynamic>{};
        return RefreshIndicator(
          onRefresh: () async => _refresh(),
          child: _content(data),
        );
      },
    );
  }

  Widget _content(Map<String, dynamic> data) {
    switch (widget.kind) {
      case ReportKind.salesRegister:
        return _salesRegister(data);
      case ReportKind.dayBook:
        return _dayBook(data);
      case ReportKind.outstanding:
        return _outstanding(data);
      case ReportKind.stockSummary:
        return _stockSummary(data);
      case ReportKind.trialBalance:
        return _trialBalance(data);
      case ReportKind.gstSummary:
        return _gstSummary(data);
      case ReportKind.profitLoss:
        return _twoColumnStatement(
          data,
          leftKey: 'left',
          rightKey: 'right',
          leftTotalKey: 'left_total',
          rightTotalKey: 'right_total',
          leftHeading: 'Expenses',
          rightHeading: 'Income',
          footer: _NumPair(
            label: 'Gross Profit',
            value: _num(data['gross_profit']),
          ),
        );
      case ReportKind.balanceSheet:
        return _twoColumnStatement(
          data,
          leftKey: 'liabilities',
          rightKey: 'assets',
          leftTotalKey: 'liab_total',
          rightTotalKey: 'asset_total',
          leftHeading: 'Liabilities',
          rightHeading: 'Assets',
        );
      case ReportKind.ledger:
        return _ledger(data);
    }
  }

  // ── Renderers: tables ──────────────────────────────────────────

  Widget _salesRegister(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final summary = _map(data['summary']);
    final cards = <Widget>[
      _SummaryStrip(items: [
        _SummaryItem('Invoices', Fmt.num0(_num(summary['count'])), AppColors.info),
        _SummaryItem('Taxable', Fmt.inr(_num(summary['total_taxable'])), AppColors.text1),
        _SummaryItem('GST', Fmt.inr(_num(summary['total_gst'])), AppColors.warn),
        _SummaryItem('Total', Fmt.inr(_num(summary['total_amount'])), AppColors.primary),
      ]),
    ];
    if (rows.isEmpty) return _listOrEmpty(cards, rows, 'No invoices in this period.');
    for (final r in rows) {
      cards.add(_RowCard(
        title: _s(r['customer'], fallback: '(no customer)'),
        subtitle: '${_s(r['invoice_no'])} · ${Fmt.date(r['date'])}'
            '${_s(r['gstin']).isEmpty ? '' : ' · ${_s(r['gstin'])}'}',
        amount: Fmt.inr(_num(r['total'])),
        amountSub: 'Taxable ${Fmt.inr(_num(r['taxable']))}  ·  GST ${Fmt.inr(_num(r['cgst']) + _num(r['sgst']))}',
        trailing: _s(r['status']).isEmpty ? null : StatusPill(_s(r['status'])),
      ));
    }
    return _list(cards);
  }

  Widget _dayBook(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final summary = _map(data['summary']);
    final cards = <Widget>[
      _SummaryStrip(items: [
        _SummaryItem('Sales', Fmt.inr(_num(summary['sales'])), AppColors.success),
        _SummaryItem('Purchase', Fmt.inr(_num(summary['purchase'])), AppColors.danger),
        _SummaryItem('Receipts', Fmt.inr(_num(summary['receipts'])), AppColors.info),
        _SummaryItem('Payments', Fmt.inr(_num(summary['payments'])), AppColors.warn),
      ]),
    ];
    if (rows.isEmpty) return _listOrEmpty(cards, rows, 'No vouchers in this period.');
    for (final r in rows) {
      cards.add(_RowCard(
        title: _s(r['party'], fallback: '—'),
        subtitle: '${_s(r['vch_no'])} · ${Fmt.date(r['date'])}',
        amount: Fmt.inr(_num(r['amount'])),
        trailing: _s(r['vch_type']).isEmpty ? null : StatusPill(_s(r['vch_type'])),
      ));
    }
    return _list(cards);
  }

  Widget _outstanding(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final summary = _map(data['summary']);
    final cards = <Widget>[
      _SummaryStrip(items: [
        _SummaryItem('Parties', Fmt.num0(_num(summary['count'])), AppColors.info),
        _SummaryItem('Outstanding', Fmt.inr(_num(summary['total_outstanding'])), AppColors.primary),
      ]),
    ];
    if (rows.isEmpty) return _listOrEmpty(cards, rows, 'Nothing outstanding.');
    for (final r in rows) {
      cards.add(_RowCard(
        title: _s(r['party'], fallback: '—'),
        subtitle: 'Opening ${Fmt.inr(_num(r['opening']))} · '
            'Invoiced ${Fmt.inr(_num(r['invoiced']))} · '
            'Settled ${Fmt.inr(_num(r['settled']))}'
            '${_s(r['gstin']).isEmpty ? '' : '\n${_s(r['gstin'])}'}',
        amount: Fmt.inr(_num(r['balance'])),
        amountColor: _num(r['balance']) < 0 ? AppColors.danger : AppColors.text1,
      ));
    }
    return _list(cards);
  }

  Widget _stockSummary(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final summary = _map(data['summary']);
    final cards = <Widget>[
      _SummaryStrip(items: [
        _SummaryItem('SKUs', Fmt.num0(_num(summary['skus'])), AppColors.info),
        _SummaryItem('Qty', Fmt.num0(_num(summary['total_qty'])), AppColors.text1),
        _SummaryItem('Value', Fmt.inr(_num(summary['total_value'])), AppColors.primary),
        _SummaryItem('Low / Out', '${Fmt.num0(_num(summary['low']))} / ${Fmt.num0(_num(summary['out']))}', AppColors.warn),
      ]),
    ];
    if (rows.isEmpty) return _listOrEmpty(cards, rows, 'No products yet.');
    for (final r in rows) {
      cards.add(_RowCard(
        title: _s(r['name'], fallback: '—'),
        subtitle: '${_s(r['category']).isEmpty ? '' : '${_s(r['category'])} · '}'
            '${Fmt.num0(_num(r['qty']))} ${_s(r['unit'])} @ ${Fmt.inr(_num(r['rate']))}',
        amount: Fmt.inr(_num(r['value'])),
        trailing: _s(r['status']).isEmpty ? null : StatusPill(_s(r['status'])),
      ));
    }
    return _list(cards);
  }

  Widget _trialBalance(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final totals = _map(data['totals']);
    final cards = <Widget>[
      AppCard(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg16, vertical: AppSpacing.md12,
        ),
        child: Column(
          children: [
            const _DrCrHeader(),
            const Divider(height: AppSpacing.lg16),
            ...rows.map((r) => _DrCrRow(
                  label: _s(r['ledger']),
                  debit: _num(r['debit']),
                  credit: _num(r['credit']),
                )),
            const Divider(height: AppSpacing.lg16),
            _DrCrRow(
              label: 'Total',
              debit: _num(totals['debit']),
              credit: _num(totals['credit']),
              bold: true,
            ),
          ],
        ),
      ),
    ];
    if (rows.isEmpty) {
      return const Center(child: EmptyState('No ledger balances yet.'));
    }
    return _list(cards);
  }

  Widget _ledger(Map<String, dynamic> data) {
    final rows = _rows(data['data']);
    final party = _map(data['party']);
    final totals = _map(data['totals']);
    final cards = <Widget>[
      AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_s(party['name'], fallback: 'Party'),
                style: Theme.of(context).textTheme.titleMedium),
            if (_s(party['gstin']).isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(_s(party['gstin']),
                  style: Theme.of(context).textTheme.bodySmall),
            ],
            const Divider(height: AppSpacing.lg16),
            _NumPair(label: 'Opening Balance', value: _num(data['opening'])),
            _NumPair(label: 'Total Debit', value: _num(totals['debit'])),
            _NumPair(label: 'Total Credit', value: _num(totals['credit'])),
            _NumPair(label: 'Closing Balance', value: _num(data['closing']), bold: true),
          ],
        ),
      ),
    ];
    if (rows.isEmpty) {
      return _listOrEmpty(cards, rows, 'No transactions for this party.');
    }
    for (final r in rows) {
      final debit = _num(r['debit']);
      final credit = _num(r['credit']);
      cards.add(_RowCard(
        title: _s(r['vtype'], fallback: '—'),
        subtitle: '${_s(r['ref'])} · ${Fmt.date(r['date'])}',
        amount: debit > 0 ? 'Dr ${Fmt.inr(debit)}' : 'Cr ${Fmt.inr(credit)}',
        amountColor: debit > 0 ? AppColors.success : AppColors.danger,
        amountSub: 'Bal ${Fmt.inr(_num(r['balance']))}',
      ));
    }
    return _list(cards);
  }

  // ── Renderers: summary statements ──────────────────────────────

  Widget _gstSummary(Map<String, dynamic> data) {
    final outward = _map(data['outward']);
    final inward = _map(data['inward']);
    return _list([
      _GstBlock(title: 'Output GST (on Sales)', m: outward, accent: AppColors.success),
      const SizedBox(height: AppSpacing.md12),
      _GstBlock(title: 'Input GST (on Purchases)', m: inward, accent: AppColors.danger),
      const SizedBox(height: AppSpacing.md12),
      AppCard(
        child: _NumPair(
          label: 'Net GST Payable',
          value: _num(data['net_payable']),
          bold: true,
        ),
      ),
    ]);
  }

  Widget _twoColumnStatement(
    Map<String, dynamic> data, {
    required String leftKey,
    required String rightKey,
    required String leftTotalKey,
    required String rightTotalKey,
    required String leftHeading,
    required String rightHeading,
    Widget? footer,
  }) {
    final left = _rows(data[leftKey]);
    final right = _rows(data[rightKey]);
    return _list([
      _StatementColumn(
        heading: leftHeading,
        rows: left,
        total: _num(data[leftTotalKey]),
      ),
      const SizedBox(height: AppSpacing.md12),
      _StatementColumn(
        heading: rightHeading,
        rows: right,
        total: _num(data[rightTotalKey]),
      ),
      if (footer != null) ...[
        const SizedBox(height: AppSpacing.md12),
        AppCard(child: footer),
      ],
    ]);
  }

  // ── List scaffolding ───────────────────────────────────────────

  Widget _list(List<Widget> children) {
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
      ),
      itemCount: children.length,
      separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
      itemBuilder: (_, i) => children[i],
    );
  }

  /// A summary-strip-only render when [rows] is empty, with an inline empty
  /// note below the strip (the first item in [cards] is the strip).
  Widget _listOrEmpty(List<Widget> cards, List rows, String emptyMsg) {
    return _list([
      ...cards,
      const SizedBox(height: AppSpacing.xl24),
      EmptyState(emptyMsg, icon: Icons.receipt_long_outlined),
    ]);
  }

  // ── Coercion helpers (pg returns numbers as strings) ───────────

  static List<Map<String, dynamic>> _rows(Object? v) {
    if (v is List) {
      return v
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList(growable: false);
    }
    return const [];
  }

  static Map<String, dynamic> _map(Object? v) =>
      (v is Map) ? v.cast<String, dynamic>() : const {};

  static num _num(Object? v) {
    if (v == null) return 0;
    if (v is num) return v;
    return num.tryParse(v.toString().trim()) ?? 0;
  }

  static String _s(Object? v, {String fallback = ''}) {
    if (v == null) return fallback;
    final s = v.toString().trim();
    return s.isEmpty ? fallback : s;
  }
}

// ─── Presentational widgets ───────────────────────────────────────

/// A From/To date chip in the filter bar.
class _DateChip extends StatelessWidget {
  const _DateChip({required this.label, required this.value, required this.onTap});
  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md12, vertical: AppSpacing.sm8,
        ),
        decoration: BoxDecoration(
          color: AppColors.scaffoldBg,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.sm8),
        ),
        child: Row(
          children: [
            const Icon(Icons.calendar_today_outlined, size: 16, color: AppColors.text2),
            const SizedBox(width: AppSpacing.sm8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: theme.textTheme.bodySmall),
                  Text(value,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Headline figures across the top of a tabular report (Invoices / Taxable /
/// GST / Total etc). Wraps so it never overflows on a narrow phone.
class _SummaryStrip extends StatelessWidget {
  const _SummaryStrip({required this.items});
  final List<_SummaryItem> items;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg16, vertical: AppSpacing.md12,
      ),
      child: Wrap(
        spacing: AppSpacing.xl24,
        runSpacing: AppSpacing.md12,
        children: items.map((it) {
          final theme = Theme.of(context);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(it.value,
                  style: theme.textTheme.titleMedium?.copyWith(color: it.color)),
              const SizedBox(height: 2),
              Text(it.label, style: theme.textTheme.bodySmall),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _SummaryItem {
  const _SummaryItem(this.label, this.value, this.color);
  final String label;
  final String value;
  final Color color;
}

/// A generic data row: left title + subtitle, right amount (+ optional amount
/// sub-line) and an optional trailing pill (status / voucher type).
class _RowCard extends StatelessWidget {
  const _RowCard({
    required this.title,
    required this.amount,
    this.subtitle,
    this.amountSub,
    this.amountColor,
    this.trailing,
  });
  final String title;
  final String amount;
  final String? subtitle;
  final String? amountSub;
  final Color? amountColor;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg16, vertical: AppSpacing.md12,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: theme.textTheme.titleMedium),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(subtitle!, style: theme.textTheme.bodySmall),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(amount,
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: amountColor ?? AppColors.text1,
                      )),
                  if (amountSub != null && amountSub!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(amountSub!,
                        style: theme.textTheme.bodySmall,
                        textAlign: TextAlign.end),
                  ],
                ],
              ),
            ],
          ),
          if (trailing != null) ...[
            const SizedBox(height: AppSpacing.sm8),
            Align(alignment: Alignment.centerLeft, child: trailing!),
          ],
        ],
      ),
    );
  }
}

/// `label …… ₹ value` line (ledger, GST net, P&L footer).
class _NumPair extends StatelessWidget {
  const _NumPair({required this.label, required this.value, this.bold = false});
  final String label;
  final num value;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = bold
        ? theme.textTheme.titleMedium
        : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(child: Text(label, style: style)),
          Text(Fmt.inr(value),
              style: style?.copyWith(
                fontWeight: FontWeight.w700,
                color: bold ? AppColors.primary : AppColors.text1,
              )),
        ],
      ),
    );
  }
}

/// Header row for the Dr/Cr trial-balance table.
class _DrCrHeader extends StatelessWidget {
  const _DrCrHeader();
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final st = theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700);
    return Row(
      children: [
        Expanded(flex: 5, child: Text('Ledger', style: st)),
        Expanded(flex: 3, child: Text('Debit', style: st, textAlign: TextAlign.end)),
        Expanded(flex: 3, child: Text('Credit', style: st, textAlign: TextAlign.end)),
      ],
    );
  }
}

/// One Dr/Cr line in the trial balance (blank when zero, like Tally).
class _DrCrRow extends StatelessWidget {
  const _DrCrRow({
    required this.label,
    required this.debit,
    required this.credit,
    this.bold = false,
  });
  final String label;
  final num debit;
  final num credit;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = bold ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium;
    final amt = base?.copyWith(
      fontWeight: bold ? FontWeight.w700 : FontWeight.w600,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(flex: 5, child: Text(label, style: base)),
          Expanded(
            flex: 3,
            child: Text(debit > 0 ? Fmt.inr(debit) : '—',
                style: amt, textAlign: TextAlign.end),
          ),
          Expanded(
            flex: 3,
            child: Text(credit > 0 ? Fmt.inr(credit) : '—',
                style: amt, textAlign: TextAlign.end),
          ),
        ],
      ),
    );
  }
}

/// A GST block (output or input): taxable + cgst/sgst/igst + total tax.
class _GstBlock extends StatelessWidget {
  const _GstBlock({required this.title, required this.m, required this.accent});
  final String title;
  final Map<String, dynamic> m;
  final Color accent;

  static num _n(Object? v) =>
      v == null ? 0 : (v is num ? v : num.tryParse(v.toString().trim()) ?? 0);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(width: 8, height: 8,
                  decoration: BoxDecoration(color: accent, shape: BoxShape.circle)),
              const SizedBox(width: AppSpacing.sm8),
              Text(title, style: theme.textTheme.titleMedium),
            ],
          ),
          const Divider(height: AppSpacing.lg16),
          _NumPair(label: 'Taxable Value', value: _n(m['taxable'])),
          _NumPair(label: 'CGST', value: _n(m['cgst'])),
          _NumPair(label: 'SGST', value: _n(m['sgst'])),
          _NumPair(label: 'IGST', value: _n(m['igst'])),
          const Divider(height: AppSpacing.md12),
          _NumPair(label: 'Total GST', value: _n(m['tax']), bold: true),
        ],
      ),
    );
  }
}

/// One side of a two-column statement (P&L / Balance Sheet): a heading, the
/// `[{label, amount}]` rows, then a bold total.
class _StatementColumn extends StatelessWidget {
  const _StatementColumn({
    required this.heading,
    required this.rows,
    required this.total,
  });
  final String heading;
  final List<Map<String, dynamic>> rows;
  final num total;

  static num _n(Object? v) =>
      v == null ? 0 : (v is num ? v : num.tryParse(v.toString().trim()) ?? 0);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(heading, style: theme.textTheme.titleMedium),
          const Divider(height: AppSpacing.lg16),
          if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm8),
              child: Text('—', style: theme.textTheme.bodySmall),
            )
          else
            ...rows.map((r) => _NumPair(
                  label: (r['label'] ?? '').toString(),
                  value: _n(r['amount']),
                )),
          const Divider(height: AppSpacing.lg16),
          _NumPair(label: 'Total', value: total, bold: true),
        ],
      ),
    );
  }
}
