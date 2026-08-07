import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/quotation.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'quotations_controller.dart';

/// Quotations — the standard mobile list pattern ([ModuleListScaffold]): search,
/// deal-status chips, card rows, pull-to-refresh and infinite scroll.
/// Data from `GET /quotations`.
///
/// [mine] renders the SAME screen scoped to the signed-in user's own rows —
/// that is the "My Quotations" item in the My Entries menu (web: `?mine=1`).
class QuotationsScreen extends ConsumerStatefulWidget {
  const QuotationsScreen({super.key, this.mine = false});
  final bool mine;

  @override
  ConsumerState<QuotationsScreen> createState() => _QuotationsScreenState();
}

class _QuotationsScreenState extends ConsumerState<QuotationsScreen> {
  // DEAL lifecycle tab — 'all' (default) | open | accepted | rejected | expired.
  String _tab = 'all';

  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  AutoDisposeStateNotifierProvider<QuotationsController, QuotationsState> get _provider =>
      widget.mine ? myQuotationsControllerProvider : quotationsControllerProvider;

  Future<void> _openFilter() async {
    final ctrl = ref.read(_provider.notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: 'Quotations filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(_provider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('quotations', 'create') ?? false;
    final ctrl = ref.read(_provider.notifier);

    final items = state is QuotationsReady ? state.items : const <Quotation>[];

    return ModuleListScaffold<Quotation>(
      title: widget.mine ? 'My Quotations' : 'Quotations',
      infoKey: 'quotations',
      searchHint: 'Search by quote no, customer…',
      emptyMessage: 'No quotations yet.',
      emptyIcon: Icons.description_outlined,
      items: items,
      loading: state is QuotationsLoading,
      error: state is QuotationsError ? state.message : null,
      hasMore: state is QuotationsReady && state.hasMore,
      loadingMore: state is QuotationsReady && state.loadingMore,
      quickFilters: const [
        QuickFilter('all', 'All'),
        QuickFilter('open', 'Open'),
        QuickFilter('accepted', 'Accepted'),
        QuickFilter('rejected', 'Rejected'),
        QuickFilter('expired', 'Expired'),
      ],
      currentQuickFilter: _tab,
      onQuickFilter: (v) {
        if (_tab == v) return;
        setState(() => _tab = v);
        ctrl.setQuoteStatus(v);
      },
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // Explicit heroTag: the app shell shows a FloatingActionButton too,
          // and two default tags in one route throw a Hero conflict.
          : FloatingActionButton.extended(
              heroTag: 'quotation-new',
              onPressed: () async {
                final created = await context.push<bool>('/quotations/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, q) => QuotationCard(
        q,
        onTap: () async {
          await context.push('/quotations/${q.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

/// One quotation row: number + customer + date on the left, amount and the
/// deal-status pill on the right. Everything else lives on the detail screen —
/// the web's wide table columns are NOT dropped, only moved.
class QuotationCard extends StatelessWidget {
  const QuotationCard(this.q, {super.key, this.onTap});
  final Quotation q;
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
                Text(q.quotationNo, style: theme.textTheme.titleMedium),
                if (q.customer != null) ...[
                  const SizedBox(height: 3),
                  Text(q.customer!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(
                  q.quotationDate == null
                      ? '—'
                      : Fmt.date(DateTime.parse(q.quotationDate!)),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(q.total ?? 0), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              StatusPill(quoteStatusLabel(q.quoteStatus)),
              if (q.isConverted) ...[
                const SizedBox(height: 4),
                Text('Invoiced', style: theme.textTheme.labelSmall),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
