import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/tally_ledger.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/filter_sheet.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import 'ledgers_controller.dart';

/// Cash / Bank / Payables / Receivables — ONE screen for all four buckets.
/// They are the same `GET /tally/ledgers?group=<bucket>` endpoint, and the
/// balances are period-derived, so the date range genuinely changes them.
class LedgersScreen extends ConsumerStatefulWidget {
  const LedgersScreen({super.key, required this.bucket});
  final LedgerBucket bucket;

  @override
  ConsumerState<LedgersScreen> createState() => _LedgersScreenState();
}

class _LedgersScreenState extends ConsumerState<LedgersScreen> {
  static final _fmt = DateFormat('yyyy-MM-dd');

  LedgerBucket get _bucket => widget.bucket;

  Future<void> _openFilter() async {
    final ctrl = ref.read(ledgersControllerProvider(_bucket).notifier);
    final res = await showFilterSheet(
      context,
      dateRange: true,
      currentFrom: DateTime.tryParse(ctrl.from),
      currentTo: DateTime.tryParse(ctrl.to),
    );
    if (res == null) return;
    if (res.cleared) {
      // "Clear all" falls back to the financial year the controller opened with.
      final now = DateTime.now();
      final fyStart =
          now.month >= 4 ? DateTime(now.year, 4, 1) : DateTime(now.year - 1, 4, 1);
      await ctrl.setRange(_fmt.format(fyStart), _fmt.format(now));
      return;
    }
    if (res.from != null && res.to != null) {
      await ctrl.setRange(_fmt.format(res.from!), _fmt.format(res.to!));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(ledgersControllerProvider(_bucket));
    final ctrl = ref.read(ledgersControllerProvider(_bucket).notifier);
    final rows = state is LedgersReady ? state.rows : const <LedgerRow>[];

    return ModuleListScaffold<LedgerRow>(
      title: _bucket.title,
      infoKey: _bucket.module,
      searchHint: 'Search ledgers…',
      emptyMessage: 'No ${_bucket.title.toLowerCase()} ledgers in this period.',
      emptyIcon: Icons.account_balance_outlined,
      items: rows,
      loading: state is LedgersLoading,
      error: state is LedgersError ? state.message : null,
      hasMore: state is LedgersReady && state.hasMore,
      loadingMore: state is LedgersReady && state.loadingMore,
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      // The range is ALWAYS set (balances are period-derived), so the filter
      // icon would otherwise read as permanently "active" — flag it only when
      // the user has moved off the default financial year.
      hasActiveFilter: false,
      itemBuilder: (context, row) => _LedgerCard(
        row,
        onTap: () => context.push('/ledgers/${Uri.encodeComponent(row.name)}'
            '?from=${ctrl.from}&to=${ctrl.to}'),
      ),
    );
  }
}

class _LedgerCard extends StatelessWidget {
  const _LedgerCard(this.row, {this.onTap});
  final LedgerRow row;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // `balance` is a MAGNITUDE; `dc` says which side it sits on.
    final isDebit = row.dc == 'Dr';
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(row.name, style: theme.textTheme.titleMedium),
                if (row.parent != null) ...[
                  const SizedBox(height: 3),
                  Text(row.parent!, style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(row.balance ?? 0), style: theme.textTheme.titleSmall),
              if (row.dc != null) ...[
                const SizedBox(height: 2),
                Text(
                  row.dc!,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: isDebit ? AppColors.success : AppColors.danger,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
