import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/return_note.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'return_notes_controller.dart';

/// Credit / Debit Notes — ONE screen serving both kinds. The API runs one
/// controller under two paths with two permission slugs, so the app mirrors
/// that instead of shipping two near-identical screens.
class ReturnNotesScreen extends ConsumerStatefulWidget {
  const ReturnNotesScreen({super.key, required this.kind});
  final ReturnNoteKind kind;

  @override
  ConsumerState<ReturnNotesScreen> createState() => _ReturnNotesScreenState();
}

class _ReturnNotesScreenState extends ConsumerState<ReturnNotesScreen> {
  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  ReturnNoteKind get _kind => widget.kind;

  Future<void> _openFilter() async {
    final ctrl = ref.read(returnNotesControllerProvider(_kind).notifier);
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
    final state = ref.watch(returnNotesControllerProvider(_kind));
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can(_kind.slug, 'create') ?? false;
    final ctrl = ref.read(returnNotesControllerProvider(_kind).notifier);

    final items = state is ReturnNotesReady ? state.items : const <ReturnNote>[];

    return ModuleListScaffold<ReturnNote>(
      title: _kind.title,
      infoKey: _kind.slug,
      registerBasePath: _kind.path,
      searchHint: 'Search by note no, ${_kind.partyLabel.toLowerCase()}…',
      emptyMessage: 'No ${_kind.title.toLowerCase()} yet.',
      emptyIcon: _kind.isCredit
          ? Icons.remove_circle_outline
          : Icons.add_circle_outline,
      items: items,
      loading: state is ReturnNotesLoading,
      error: state is ReturnNotesError ? state.message : null,
      hasMore: state is ReturnNotesReady && state.hasMore,
      loadingMore: state is ReturnNotesReady && state.loadingMore,
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
                final created = await context.push<bool>('/${_kind.slug}/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, note) => ReturnNoteCard(
        note,
        kind: _kind,
        onTap: () async {
          await context.push('/${_kind.slug}/${note.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

/// One note row: number + party + date, with the amount and Tally-sync pill.
class ReturnNoteCard extends StatelessWidget {
  const ReturnNoteCard(this.note, {super.key, required this.kind, this.onTap});
  final ReturnNote note;
  final ReturnNoteKind kind;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final party = note.party(kind);
    final date = note.invoiceDate == null ? null : DateTime.tryParse(note.invoiceDate!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(note.invoiceNo, style: theme.textTheme.titleMedium),
                if (party != null) ...[
                  const SizedBox(height: 3),
                  Text(party, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(date == null ? '—' : Fmt.date(date),
                    style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(note.total ?? 0), style: theme.textTheme.titleSmall),
              if (note.status != null) ...[
                const SizedBox(height: 6),
                StatusPill(note.status!),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
