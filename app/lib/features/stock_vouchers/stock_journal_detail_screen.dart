import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/stock_voucher.dart';
import '../../data/repositories/stock_voucher_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// One stock journal, split into the SOURCE lines (stock out) and the
/// DESTINATION lines (stock in) — the shape the voucher actually has. There is
/// no edit: a wrong transfer is reversed with another journal.
class StockJournalDetailScreen extends ConsumerStatefulWidget {
  const StockJournalDetailScreen({super.key, required this.journalId});
  final int journalId;

  @override
  ConsumerState<StockJournalDetailScreen> createState() =>
      _StockJournalDetailScreenState();
}

class _StockJournalDetailScreenState extends ConsumerState<StockJournalDetailScreen> {
  StockJournal? _sj;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final sj = await ref.read(stockJournalRepositoryProvider).get(widget.journalId);
      if (mounted) setState(() => _sj = sj);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this stock journal.');
    }
  }

  Future<void> _delete() async {
    final sj = _sj;
    if (sj == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete stock journal?',
      message: '${sj.voucherNo} will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      await ref.read(stockJournalRepositoryProvider).delete(sj.id);
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canDelete = user?.can('stock-journal', 'delete') ?? false;
    final sj = _sj;

    return Scaffold(
      appBar: AppBar(
        title: Text(sj?.voucherNo ?? 'Stock Journal'),
        actions: [
          if (sj != null && canDelete)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _busy ? null : _delete,
            ),
        ],
      ),
      body: _body(sj),
    );
  }

  Widget _body(StockJournal? sj) {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    if (sj == null) return const LoadingState(message: 'Loading stock journal…');

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: [
          const DetailSection('Details', first: true),
          AppCard(
            child: Column(
              children: [
                DetailRow('Voucher No', sj.voucherNo),
                DetailRow(
                  'Date',
                  sj.journalDate == null
                      ? null
                      : Fmt.date(DateTime.parse(sj.journalDate!)),
                ),
                DetailRow('Sync Status', sj.status),
                DetailRow('Narration', sj.narration),
              ],
            ),
          ),
          DetailSection('Source — stock out (${sj.sources.length})'),
          if (sj.sources.isEmpty)
            const Text('No source lines.')
          else
            for (final it in sj.sources) ...[
              _LineCard(it, out: true),
              const SizedBox(height: AppSpacing.sm8),
            ],
          DetailSection('Destination — stock in (${sj.destinations.length})'),
          if (sj.destinations.isEmpty)
            const Text('No destination lines.')
          else
            for (final it in sj.destinations) ...[
              _LineCard(it, out: false),
              const SizedBox(height: AppSpacing.sm8),
            ],
        ],
      ),
    );
  }
}

class _LineCard extends StatelessWidget {
  const _LineCard(this.item, {required this.out});
  final StockJournalItem item;
  final bool out;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Row(
        children: [
          Icon(
            out ? Icons.arrow_upward : Icons.arrow_downward,
            size: 18,
            color: out ? AppColors.danger : AppColors.success,
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.productName ?? 'Item #${item.productId ?? '—'}',
                    style: theme.textTheme.titleMedium),
                if (item.godown != null) ...[
                  const SizedBox(height: 2),
                  Text(item.godown!, style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('${item.quantity ?? 0}', style: theme.textTheme.titleSmall),
              if (item.rate != null)
                Text(Fmt.inr(item.rate!), style: theme.textTheme.bodySmall),
            ],
          ),
        ],
      ),
    );
  }
}
