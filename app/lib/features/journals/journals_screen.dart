import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart' show invoiceStatusLabel;
import '../../data/models/journal.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'journals_controller.dart';

/// Journals — searchable, paginated list with pull-to-refresh, infinite scroll,
/// and a + button to add. Data from `GET /journals`.
class JournalsScreen extends ConsumerStatefulWidget {
  const JournalsScreen({super.key});

  @override
  ConsumerState<JournalsScreen> createState() => _JournalsScreenState();
}

class _JournalsScreenState extends ConsumerState<JournalsScreen> {
  final _searchCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _scrollCtl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtl.dispose();
    _scrollCtl.removeListener(_onScroll);
    _scrollCtl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtl.position.pixels >= _scrollCtl.position.maxScrollExtent - 240) {
      ref.read(journalsControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(journalsControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(journalsControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Journals')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/journals/add');
          if (created == true) {
            ref.read(journalsControllerProvider.notifier).refresh();
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('New'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by voucher no, ledger…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(JournalsState state) {
    switch (state) {
      case JournalsLoading():
        return const LoadingState(message: 'Loading journals…');
      case JournalsError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(journalsControllerProvider.notifier).refresh(),
        );
      case JournalsReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No journal vouchers yet.', icon: Icons.swap_horiz);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(journalsControllerProvider.notifier).refresh(),
          child: ListView.separated(
            controller: _scrollCtl,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32,
            ),
            itemCount: items.length + (hasMore ? 1 : 0),
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              if (i >= items.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg16),
                  child: Center(
                    child: loadingMore
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : const SizedBox.shrink(),
                  ),
                );
              }
              return _JournalCard(items[i]);
            },
          ),
        );
    }
  }
}

class _JournalCard extends StatelessWidget {
  const _JournalCard(this.j);
  final Journal j;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ledgers = [j.drLedger, j.crLedger].where((x) => x != null && x.isNotEmpty).join('  →  ');
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${j.voucherNo}${j.vchType != null ? ' · ${j.vchType}' : ''}',
                    style: theme.textTheme.titleMedium),
                if (ledgers.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(ledgers, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(Fmt.date(j.journalDate), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(j.amount), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              if (j.status != null) StatusPill(invoiceStatusLabel(j.status)),
            ],
          ),
        ],
      ),
    );
  }
}
