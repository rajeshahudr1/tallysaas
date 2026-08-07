import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/stock_voucher.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import 'stock_vouchers_controller.dart';

/// Stock Journals — transfers / conversions of stock between godowns or items.
/// No party, no ledger, no GST: quantities only.
class StockJournalsScreen extends ConsumerStatefulWidget {
  const StockJournalsScreen({super.key});

  @override
  ConsumerState<StockJournalsScreen> createState() => _StockJournalsScreenState();
}

class _StockJournalsScreenState extends ConsumerState<StockJournalsScreen> {
  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(stockJournalsControllerProvider.notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: 'Stock Journals filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(stockJournalsControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('stock-journal', 'create') ?? false;
    final ctrl = ref.read(stockJournalsControllerProvider.notifier);

    final items = state is StockListReady<StockJournal>
        ? state.items
        : const <StockJournal>[];

    return ModuleListScaffold<StockJournal>(
      title: 'Stock Journals',
      infoKey: 'stock-journal',
      searchHint: 'Search by voucher no…',
      emptyMessage: 'No stock journals yet.',
      emptyIcon: Icons.inventory_outlined,
      items: items,
      loading: state is StockListLoading<StockJournal>,
      error: state is StockListError<StockJournal> ? state.message : null,
      hasMore: state is StockListReady<StockJournal> && state.hasMore,
      loadingMore: state is StockListReady<StockJournal> && state.loadingMore,
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: 'stock-journal-new',
              onPressed: () async {
                final created = await context.push<bool>('/stock-journals/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, sj) => _StockJournalCard(
        sj,
        onTap: () async {
          await context.push('/stock-journals/${sj.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

class _StockJournalCard extends StatelessWidget {
  const _StockJournalCard(this.sj, {this.onTap});
  final StockJournal sj;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = sj.journalDate == null ? null : DateTime.tryParse(sj.journalDate!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sj.voucherNo, style: theme.textTheme.titleMedium),
                if (sj.narration != null) ...[
                  const SizedBox(height: 3),
                  Text(sj.narration!,
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 2),
                Text(date == null ? '—' : Fmt.date(date),
                    style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}
