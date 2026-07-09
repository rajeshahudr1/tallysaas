import 'dart:async';

import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'sales_invoices_controller.dart';

/// Sales Invoices — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /sales-invoices`.
class SalesInvoicesScreen extends ConsumerStatefulWidget {
  const SalesInvoicesScreen({super.key});

  @override
  ConsumerState<SalesInvoicesScreen> createState() => _SalesInvoicesScreenState();
}

class _SalesInvoicesScreenState extends ConsumerState<SalesInvoicesScreen> {
  final _searchCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  Timer? _debounce;
  // SFA approval tab — 'approved' (default, real sales) | 'pending' | 'all'.
  String _tab = 'approved';

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
      ref.read(salesInvoicesControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(salesInvoicesControllerProvider.notifier).search(q);
    });
  }

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
    final hasFilter = ref.read(salesInvoicesControllerProvider.notifier).adv.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sales Invoices'),
        actions: [
          const ModuleInfoButton('sales-invoices'),
          IconButton(
            icon: Icon(hasFilter ? Icons.filter_alt : Icons.tune),
            color: hasFilter ? AppColors.primary : null,
            tooltip: 'Filter',
            onPressed: _openFilter,
          ),
        ],
      ),
      floatingActionButton: !canCreate
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final created = await context.push<bool>('/sales-invoices/add');
                if (created == true) {
                  ref.read(salesInvoicesControllerProvider.notifier).refresh();
                }
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      body: Column(
        children: [
          _approvalTabs(),
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by invoice no, customer…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  /// Approval tabs: only APPROVED invoices are the real, counted sales; PENDING
  /// are awaiting a company-admin's approval. Mirrors the web tabs.
  Widget _approvalTabs() {
    const tabs = [('approved', 'Approved'), ('pending', 'Pending'), ('all', 'All')];
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.sm8),
      child: Row(
        children: [
          for (final t in tabs) ...[
            Expanded(
              child: GestureDetector(
                onTap: () {
                  if (_tab == t.$1) return;
                  setState(() => _tab = t.$1);
                  ref.read(salesInvoicesControllerProvider.notifier).setApproval(t.$1);
                },
                child: Container(
                  height: 38,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: _tab == t.$1 ? AppColors.primary : Colors.white,
                    borderRadius: BorderRadius.circular(AppRadius.sm8),
                    border: Border.all(color: _tab == t.$1 ? AppColors.primary : AppColors.border),
                  ),
                  child: Text(
                    t.$2,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: _tab == t.$1 ? Colors.white : AppColors.text2,
                    ),
                  ),
                ),
              ),
            ),
            if (t.$1 != 'all') const SizedBox(width: AppSpacing.sm8),
          ],
        ],
      ),
    );
  }

  Widget _body(SalesInvoicesState state) {
    final session = ref.read(sessionProvider);
    final isSalesman = session is SessionSignedIn && session.user.isSalesman;
    switch (state) {
      case SalesInvoicesLoading():
        return const LoadingState(message: 'Loading invoices…');
      case SalesInvoicesError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(salesInvoicesControllerProvider.notifier).refresh(),
        );
      case SalesInvoicesReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No sales invoices yet.', icon: Icons.receipt_long_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(salesInvoicesControllerProvider.notifier).refresh(),
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
              final inv = items[i];
              return _InvoiceCard(
                inv,
                // A salesman only cares about approval, not the Tally-sync
                // lifecycle — hide the sync-status pill for them (matches web).
                showSyncStatus: !isSalesman,
                onTap: () async {
                  await context.push('/sales-invoices/${inv.id}');
                  if (context.mounted) {
                    ref.read(salesInvoicesControllerProvider.notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
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
