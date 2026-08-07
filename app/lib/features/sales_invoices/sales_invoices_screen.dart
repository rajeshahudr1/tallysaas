import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'sales_invoices_controller.dart';

/// Sales Invoices — the REFERENCE module for the standard mobile list pattern
/// (`ModuleListScaffold`): search, quick-filter chips, card rows, pull-to-refresh
/// and infinite scroll. Every other module copies this shape. Data from
/// `GET /sales-invoices`.
class SalesInvoicesScreen extends ConsumerStatefulWidget {
  const SalesInvoicesScreen({super.key});

  @override
  ConsumerState<SalesInvoicesScreen> createState() => _SalesInvoicesScreenState();
}

class _SalesInvoicesScreenState extends ConsumerState<SalesInvoicesScreen> {
  // SFA approval tab — 'approved' (default, real sales) | 'pending' | 'all'.
  // Search, scrolling and pagination now live in ModuleListScaffold.
  String _tab = 'approved';

  static const _fields = [
    FilterField('status', 'Status', FType.select,
        options: ['pending_tally', 'sent_to_tally', 'created', 'failed'],
        optionLabels: {'pending_tally': 'Pending', 'sent_to_tally': 'Sent', 'created': 'Synced', 'failed': 'Failed'}),
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(salesInvoicesControllerProvider.notifier);
    final res = await showAdvancedFilter(context, ref, title: 'Sales Invoices filter', fields: _fields, current: ctrl.adv);
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(salesInvoicesControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('sales-invoices', 'create') ?? false;
    // A salesman only cares about approval, not the Tally-sync lifecycle — hide
    // the sync pill for them. A customer-portal login sees the same (back-office
    // concern), which matches the web list.
    final isSalesman = user?.isSalesman ?? false;
    final isCustomerUser = user?.isCustomerUser ?? false;
    final ctrl = ref.read(salesInvoicesControllerProvider.notifier);

    final items = state is SalesInvoicesReady ? state.items : const <Invoice>[];

    return ModuleListScaffold<Invoice>(
      title: 'Sales Invoices',
      infoKey: 'sales-invoices',
      searchHint: 'Search by invoice no, customer…',
      emptyMessage: 'No sales invoices yet.',
      emptyIcon: Icons.receipt_long_outlined,
      items: items,
      loading: state is SalesInvoicesLoading,
      error: state is SalesInvoicesError ? state.message : null,
      hasMore: state is SalesInvoicesReady && state.hasMore,
      loadingMore: state is SalesInvoicesReady && state.loadingMore,
      // Approval tabs: only APPROVED invoices are the real, counted sales;
      // PENDING await a company-admin's approval. Mirrors the web tabs.
      quickFilters: const [
        QuickFilter('approved', 'Approved'),
        QuickFilter('pending', 'Pending'),
        QuickFilter('all', 'All'),
      ],
      currentQuickFilter: _tab,
      onQuickFilter: (v) {
        if (_tab == v) return;
        setState(() => _tab = v);
        ctrl.setApproval(v);
      },
      onSearch: ctrl.search,
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      onFilter: _openFilter,
      hasActiveFilter: ctrl.adv.isNotEmpty,
      fab: !canCreate
          ? null
          // An explicit heroTag: the shell shows a FloatingActionButton too, and
          // two default tags in one route throw a Hero conflict.
          : FloatingActionButton.extended(
              heroTag: 'sales-invoice-new',
              onPressed: () async {
                final created = await context.push<bool>('/sales-invoices/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, inv) => _InvoiceCard(
        inv,
        showSyncStatus: !isSalesman && !isCustomerUser,
        onTap: () async {
          await context.push('/sales-invoices/${inv.id}');
          if (context.mounted) ctrl.refresh();
        },
      ),
    );
  }
}

class _InvoiceCard extends StatelessWidget {
  const _InvoiceCard(this.inv, {this.onTap, this.showSyncStatus = true});
  final Invoice inv;
  final VoidCallback? onTap;
  /// Whether to show the Tally sync-status pill (hidden for a salesman).
  final bool showSyncStatus;

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
                Text(inv.invoiceNo, style: theme.textTheme.titleMedium),
                if (inv.party != null) ...[
                  const SizedBox(height: 3),
                  Text(inv.party!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 2),
                Text(Fmt.date(inv.invoiceDate), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(inv.total), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              if (showSyncStatus && inv.status != null) StatusPill(invoiceStatusLabel(inv.status)),
            ],
          ),
        ],
      ),
    );
  }
}
