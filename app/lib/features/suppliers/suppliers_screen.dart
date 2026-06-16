import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/supplier.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'suppliers_controller.dart';

/// Suppliers master — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /suppliers` (company-scoped via
/// the X-Company-Id header). Mirrors the Customers screen.
class SuppliersScreen extends ConsumerStatefulWidget {
  const SuppliersScreen({super.key});

  @override
  ConsumerState<SuppliersScreen> createState() => _SuppliersScreenState();
}

class _SuppliersScreenState extends ConsumerState<SuppliersScreen> {
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
      ref.read(suppliersControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(suppliersControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(suppliersControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Suppliers')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/suppliers/add');
          if (created == true) {
            ref.read(suppliersControllerProvider.notifier).refresh();
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('Add'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by name, mobile, email…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(SuppliersState state) {
    switch (state) {
      case SuppliersLoading():
        return const LoadingState(message: 'Loading suppliers…');
      case SuppliersError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(suppliersControllerProvider.notifier).refresh(),
        );
      case SuppliersReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No suppliers found.', icon: Icons.local_shipping_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(suppliersControllerProvider.notifier).refresh(),
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
              return _SupplierCard(items[i]);
            },
          ),
        );
    }
  }
}

class _SupplierCard extends StatelessWidget {
  const _SupplierCard(this.s);
  final Supplier s;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle =
        [s.mobile, s.location, s.supplierGroup].where((x) => x != null && x.isNotEmpty).join(' · ');
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.name, style: theme.textTheme.titleMedium),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(subtitle, style: theme.textTheme.bodySmall),
                ],
                if (s.gstNumber != null) ...[
                  const SizedBox(height: 2),
                  Text('GST: ${s.gstNumber}', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (s.status != null) StatusPill(s.status!),
              if (s.openingBalance != null) ...[
                const SizedBox(height: 6),
                Text('Payable ${Fmt.inr(s.openingBalance)}',
                    style: theme.textTheme.bodySmall),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
