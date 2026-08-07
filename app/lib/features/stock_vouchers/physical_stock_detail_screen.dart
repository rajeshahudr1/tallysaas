import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/stock_voucher.dart';
import '../../data/repositories/stock_voucher_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// One physical-stock sheet and every line counted on it. Sheets are read-only:
/// the API has no edit or delete — a wrong count is corrected by a new sheet.
class PhysicalStockDetailScreen extends ConsumerStatefulWidget {
  const PhysicalStockDetailScreen({super.key, required this.voucherNo});
  final String voucherNo;

  @override
  ConsumerState<PhysicalStockDetailScreen> createState() =>
      _PhysicalStockDetailScreenState();
}

class _PhysicalStockDetailScreenState
    extends ConsumerState<PhysicalStockDetailScreen> {
  PhysicalStockSheet? _sheet;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final s = await ref
          .read(physicalStockRepositoryProvider)
          .get(widget.voucherNo);
      if (mounted) setState(() => _sheet = s);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this stock count.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final sheet = _sheet;
    return Scaffold(
      appBar: AppBar(title: Text(sheet?.voucherNo ?? widget.voucherNo)),
      body: _body(sheet),
    );
  }

  Widget _body(PhysicalStockSheet? sheet) {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    if (sheet == null) return const LoadingState(message: 'Loading stock count…');

    final theme = Theme.of(context);
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
                DetailRow('Voucher No', sheet.voucherNo),
                DetailRow(
                  'Count Date',
                  sheet.countDate == null
                      ? null
                      : Fmt.date(DateTime.parse(sheet.countDate!)),
                ),
                DetailRow('Narration', sheet.narration),
              ],
            ),
          ),
          DetailSection('Counted items (${sheet.items.length})'),
          for (final it in sheet.items) ...[
            AppCard(
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(it.productName ?? 'Item #${it.productId ?? '—'}',
                            style: theme.textTheme.titleMedium),
                        if (it.productSku != null || it.godown != null) ...[
                          const SizedBox(height: 2),
                          Text(
                            [
                              if (it.productSku != null) it.productSku!,
                              if (it.godown != null) it.godown!,
                            ].join('  •  '),
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ],
                    ),
                  ),
                  Text('${it.countedQty ?? 0}', style: theme.textTheme.titleSmall),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ],
      ),
    );
  }
}
