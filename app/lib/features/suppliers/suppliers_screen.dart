import 'dart:async';

import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/supplier.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/advanced_filter.dart';
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

  static const _fields = [
    FilterField('status', 'Status', FType.select, options: ['Active', 'Inactive', 'Blocked']),
    FilterField('location', 'Location', FType.dynamicSelect, endpoint: '/locations'),
    FilterField('supplier_group', 'Supplier Group', FType.dynamicSelect, endpoint: '/supplier-groups'),
    FilterField('gst', 'GST No.', FType.text),
    FilterField('created_from', 'Created From', FType.dateFrom),
    FilterField('created_to', 'Created To', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(suppliersControllerProvider.notifier);
    final res = await showAdvancedFilter(context, ref, title: 'Suppliers filter', fields: _fields, current: ctrl.adv);
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(suppliersControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // RBAC: Add shows ONLY when the role grants 'suppliers.create'.
    final canCreate = user?.can('suppliers', 'create') ?? false;
    final hasFilter = ref.read(suppliersControllerProvider.notifier).adv.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Suppliers'),
        actions: [
          const ModuleInfoButton('suppliers'),
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
              final s = items[i];
              return _SupplierCard(
                s,
                onTap: () async {
                  await context.push('/suppliers/${s.id}');
                  if (context.mounted) {
                    ref.read(suppliersControllerProvider.notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
  }
}

class _SupplierCard extends StatelessWidget {
  const _SupplierCard(this.s, {this.onTap});
  final Supplier s;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle =
        [s.mobile, s.location, s.supplierGroup].where((x) => x != null && x.isNotEmpty).join(' · ');
    return AppCard(
      onTap: onTap,
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
