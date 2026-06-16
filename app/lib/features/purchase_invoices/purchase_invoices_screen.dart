import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'purchase_invoices_controller.dart';

/// Purchase Invoices — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /purchase-invoices`.
class PurchaseInvoicesScreen extends ConsumerStatefulWidget {
  const PurchaseInvoicesScreen({super.key});

  @override
  ConsumerState<PurchaseInvoicesScreen> createState() => _PurchaseInvoicesScreenState();
}

class _PurchaseInvoicesScreenState extends ConsumerState<PurchaseInvoicesScreen> {
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
      ref.read(purchaseInvoicesControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(purchaseInvoicesControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(purchaseInvoicesControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Purchase Invoices')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/purchase-invoices/add');
          if (created == true) {
            ref.read(purchaseInvoicesControllerProvider.notifier).refresh();
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
              hint: 'Search by invoice no, supplier…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(PurchaseInvoicesState state) {
    switch (state) {
      case PurchaseInvoicesLoading():
        return const LoadingState(message: 'Loading invoices…');
      case PurchaseInvoicesError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(purchaseInvoicesControllerProvider.notifier).refresh(),
        );
      case PurchaseInvoicesReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No purchase invoices yet.', icon: Icons.shopping_bag_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(purchaseInvoicesControllerProvider.notifier).refresh(),
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
              return _InvoiceCard(items[i]);
            },
          ),
        );
    }
  }
}

class _InvoiceCard extends StatelessWidget {
  const _InvoiceCard(this.inv);
  final Invoice inv;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
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
              if (inv.status != null) StatusPill(invoiceStatusLabel(inv.status)),
            ],
          ),
        ],
      ),
    );
  }
}
