import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/goods_note.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'goods_notes_controller.dart';

/// Delivery / Receipt Notes — ONE screen for both kinds, on the standard mobile
/// list pattern: search, lifecycle chips, cards, pull-to-refresh, infinite
/// scroll.
class GoodsNotesScreen extends ConsumerStatefulWidget {
  const GoodsNotesScreen({super.key, required this.kind});
  final GoodsNoteKind kind;

  @override
  ConsumerState<GoodsNotesScreen> createState() => _GoodsNotesScreenState();
}

class _GoodsNotesScreenState extends ConsumerState<GoodsNotesScreen> {
  String _tab = 'all';

  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  GoodsNoteKind get _kind => widget.kind;

  Future<void> _openFilter() async {
    final ctrl = ref.read(goodsNotesControllerProvider(_kind).notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: '${_kind.title} filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(goodsNotesControllerProvider(_kind));
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can(_kind.slug, 'create') ?? false;
    final ctrl = ref.read(goodsNotesControllerProvider(_kind).notifier);

    final items = state is GoodsNotesReady ? state.items : const <GoodsNote>[];

    return ModuleListScaffold<GoodsNote>(
      title: _kind.title,
      infoKey: _kind.slug,
      registerBasePath: _kind.path,
      searchHint: 'Search by note no, ${_kind.partyLabel.toLowerCase()}…',
      emptyMessage: 'No ${_kind.title.toLowerCase()} yet.',
      emptyIcon: _kind.isDelivery
          ? Icons.local_shipping_outlined
          : Icons.move_to_inbox_outlined,
      items: items,
      loading: state is GoodsNotesLoading,
      error: state is GoodsNotesError ? state.message : null,
      hasMore: state is GoodsNotesReady && state.hasMore,
      loadingMore: state is GoodsNotesReady && state.loadingMore,
      quickFilters: const [
        QuickFilter('all', 'All'),
        QuickFilter('pending', 'Pending'),
        QuickFilter('invoiced', 'Invoiced'),
        QuickFilter('cancelled', 'Cancelled'),
      ],
      currentQuickFilter: _tab,
      onQuickFilter: (v) {
        if (_tab == v) return;
        setState(() => _tab = v);
        ctrl.setNoteStatus(v);
      },
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: '${_kind.slug}-new',
              onPressed: () async {
                final created = await context.push<bool>('${_kind.path}/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, note) => GoodsNoteCard(
        note,
        kind: _kind,
        onTap: () async {
          await context.push('${_kind.path}/${note.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

/// One note row: number + party + movement date, amount and lifecycle pill.
class GoodsNoteCard extends StatelessWidget {
  const GoodsNoteCard(this.note, {super.key, required this.kind, this.onTap});
  final GoodsNote note;
  final GoodsNoteKind kind;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final moved = note.movementDate == null
        ? null
        : DateTime.tryParse(note.movementDate!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(note.noteNo, style: theme.textTheme.titleMedium),
                if (note.party != null) ...[
                  const SizedBox(height: 3),
                  Text(note.party!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(
                  moved == null
                      ? '—'
                      : '${kind.isDelivery ? 'Dispatched' : 'Received'} ${Fmt.date(moved)}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(note.total ?? 0), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              StatusPill(goodsNoteStatusLabel(note.noteStatus)),
            ],
          ),
        ],
      ),
    );
  }
}
