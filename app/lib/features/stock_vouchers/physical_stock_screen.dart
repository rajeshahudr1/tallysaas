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

/// Physical Stock — the stock-count sheets. One row per sheet (the API groups
/// the counted lines by voucher number). The endpoint has no text search, so
/// this list filters by date only.
class PhysicalStockScreen extends ConsumerStatefulWidget {
  const PhysicalStockScreen({super.key});

  @override
  ConsumerState<PhysicalStockScreen> createState() => _PhysicalStockScreenState();
}

class _PhysicalStockScreenState extends ConsumerState<PhysicalStockScreen> {
  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(physicalStockControllerProvider.notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: 'Physical Stock filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(physicalStockControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('physical-stock', 'create') ?? false;
    final ctrl = ref.read(physicalStockControllerProvider.notifier);

    final items = state is StockListReady<PhysicalStockSheet>
        ? state.items
        : const <PhysicalStockSheet>[];

    return ModuleListScaffold<PhysicalStockSheet>(
      title: 'Physical Stock',
      infoKey: 'physical-stock',
      emptyMessage: 'No stock counts yet.',
      emptyIcon: Icons.checklist_outlined,
      items: items,
      loading: state is StockListLoading<PhysicalStockSheet>,
      error: state is StockListError<PhysicalStockSheet> ? state.message : null,
      hasMore: state is StockListReady<PhysicalStockSheet> && state.hasMore,
      loadingMore: state is StockListReady<PhysicalStockSheet> && state.loadingMore,
      // The API offers no `search` on this endpoint — a sheet has no party or
      // narration to match on — so searching is a no-op here.
      onSearch: (_) {},
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: 'physical-stock-new',
              onPressed: () async {
                final created = await context.push<bool>('/physical-stock/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, sheet) => _SheetCard(
        sheet,
        onTap: () async {
          await context.push('/physical-stock/${Uri.encodeComponent(sheet.voucherNo)}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

class _SheetCard extends StatelessWidget {
  const _SheetCard(this.sheet, {this.onTap});
  final PhysicalStockSheet sheet;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = sheet.countDate == null ? null : DateTime.tryParse(sheet.countDate!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sheet.voucherNo, style: theme.textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(date == null ? '—' : Fmt.date(date),
                    style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          if (sheet.itemCount != null)
            Text('${sheet.itemCount} items', style: theme.textTheme.bodySmall),
          const SizedBox(width: AppSpacing.sm8),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}
