import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/purchase_order.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'purchase_orders_controller.dart';

/// Purchase Orders — the standard mobile list pattern: search, delivery-status
/// chips, card rows, pull-to-refresh, infinite scroll. Data from
/// `GET /purchase-orders`.
class PurchaseOrdersScreen extends ConsumerStatefulWidget {
  const PurchaseOrdersScreen({super.key});

  @override
  ConsumerState<PurchaseOrdersScreen> createState() => _PurchaseOrdersScreenState();
}

class _PurchaseOrdersScreenState extends ConsumerState<PurchaseOrdersScreen> {
  // DELIVERY lifecycle tab.
  String _tab = 'all';

  static const _fields = [
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(purchaseOrdersControllerProvider.notifier);
    final res = await showAdvancedFilter(
      context,
      ref,
      title: 'Purchase Orders filter',
      fields: _fields,
      current: ctrl.adv,
    );
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(purchaseOrdersControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('purchase-orders', 'create') ?? false;
    final ctrl = ref.read(purchaseOrdersControllerProvider.notifier);

    final items = state is PurchaseOrdersReady ? state.items : const <PurchaseOrder>[];

    return ModuleListScaffold<PurchaseOrder>(
      title: 'Purchase Orders',
      infoKey: 'purchase-orders',
      registerBasePath: '/purchase-orders',
      searchHint: 'Search by order no, supplier…',
      emptyMessage: 'No purchase orders yet.',
      emptyIcon: Icons.local_shipping_outlined,
      items: items,
      loading: state is PurchaseOrdersLoading,
      error: state is PurchaseOrdersError ? state.message : null,
      hasMore: state is PurchaseOrdersReady && state.hasMore,
      loadingMore: state is PurchaseOrdersReady && state.loadingMore,
      quickFilters: const [
        QuickFilter('all', 'All'),
        QuickFilter('pending', 'Pending'),
        QuickFilter('partially_delivered', 'Partial'),
        QuickFilter('delivered', 'Delivered'),
        QuickFilter('cancelled', 'Cancelled'),
      ],
      currentQuickFilter: _tab,
      onQuickFilter: (v) {
        if (_tab == v) return;
        setState(() => _tab = v);
        ctrl.setOrderStatus(v);
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
              heroTag: 'purchase-order-new',
              onPressed: () async {
                final created = await context.push<bool>('/purchase-orders/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, so) => PurchaseOrderCard(
        so,
        onTap: () async {
          await context.push('/purchase-orders/${so.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

/// One order row: number + customer + due date on the left, amount and the
/// delivery-status pill on the right.
class PurchaseOrderCard extends StatelessWidget {
  const PurchaseOrderCard(this.so, {super.key, this.onTap});
  final PurchaseOrder so;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final due = so.dueOn == null ? null : DateTime.tryParse(so.dueOn!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(so.orderNo, style: theme.textTheme.titleMedium),
                if (so.supplier != null) ...[
                  const SizedBox(height: 3),
                  Text(so.supplier!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(
                  due == null ? '—' : 'Due ${Fmt.date(due)}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(so.total ?? 0), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              StatusPill(orderStatusLabel(so.orderStatus)),
              if (so.isConverted) ...[
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
