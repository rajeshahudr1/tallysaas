import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart' show invoiceStatusLabel;
import '../../data/models/journal.dart';
import '../../data/repositories/journal_repository.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'journals_controller.dart';

/// Journals / Contra — ONE screen for both, keyed by [JournalScope]. Contra is
/// the same `journals` table forced to `vch_type: 'Contra'` by the API, with
/// its own permission slug, so the app mirrors that rather than duplicating a
/// near-identical screen. Data from `GET /journals` or `GET /contra`.
class JournalsScreen extends ConsumerStatefulWidget {
  const JournalsScreen({super.key, this.scope = JournalScope.journals});
  final JournalScope scope;

  @override
  ConsumerState<JournalsScreen> createState() => _JournalsScreenState();
}

class _JournalsScreenState extends ConsumerState<JournalsScreen> {
  static const _fields = [
    FilterField('status', 'Status', FType.select,
        options: ['pending_tally', 'sent_to_tally', 'created', 'failed'],
        optionLabels: {
          'pending_tally': 'Pending',
          'sent_to_tally': 'Sent',
          'created': 'Synced',
          'failed': 'Failed',
        }),
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  JournalScope get _scope => widget.scope;

  Future<void> _openFilter() async {
    final ctrl = ref.read(journalsControllerProvider(_scope).notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: '${_scope.title} filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(journalsControllerProvider(_scope));
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can(_scope.module, 'create') ?? false;
    final ctrl = ref.read(journalsControllerProvider(_scope).notifier);

    final items = state is JournalsReady ? state.items : const <Journal>[];

    return ModuleListScaffold<Journal>(
      title: _scope.title,
      infoKey: _scope.module,
      searchHint: 'Search by voucher no, ledger…',
      emptyMessage: 'No ${_scope.title.toLowerCase()} vouchers yet.',
      emptyIcon: _scope == JournalScope.contra
          ? Icons.swap_horiz
          : Icons.menu_book_outlined,
      items: items,
      loading: state is JournalsLoading,
      error: state is JournalsError ? state.message : null,
      hasMore: state is JournalsReady && state.hasMore,
      loadingMore: state is JournalsReady && state.loadingMore,
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: '${_scope.module}-new',
              onPressed: () async {
                final created = await context.push<bool>('${_scope.path}/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, j) => JournalCard(
        j,
        onTap: () async {
          await context.push('${_scope.path}/${j.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

/// One voucher row: number + Dr/Cr ledgers + date, amount and sync pill.
class JournalCard extends StatelessWidget {
  const JournalCard(this.j, {super.key, this.onTap});
  final Journal j;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(j.voucherNo, style: theme.textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(
                  'Dr ${j.drLedger ?? '—'}  →  Cr ${j.crLedger ?? '—'}',
                  style: theme.textTheme.bodySmall,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  j.journalDate == null ? '—' : Fmt.date(j.journalDate),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(j.amount ?? 0), style: theme.textTheme.titleSmall),
              if (j.status != null) ...[
                const SizedBox(height: 6),
                StatusPill(invoiceStatusLabel(j.status)),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
