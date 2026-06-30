import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/customer.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'customer_filter_sheet.dart';
import 'customers_controller.dart';

/// Customers master — searchable, paginated list of customer cards with a
/// pull-to-refresh, infinite scroll, and a + button to add. Data comes from
/// `GET /customers` (company-scoped via the X-Company-Id header).
class CustomersScreen extends ConsumerStatefulWidget {
  const CustomersScreen({super.key});

  @override
  ConsumerState<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends ConsumerState<CustomersScreen> {
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
      ref.read(customersControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(customersControllerProvider.notifier).search(q);
    });
  }

  Future<void> _openFilter() async {
    final ctrl = ref.read(customersControllerProvider.notifier);
    final res = await showCustomerFilter(context, ref, ctrl.filter);
    if (res == null) return;
    _searchCtl.text = res.search ?? ''; // keep the top search box in sync
    ctrl.setFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(customersControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // RBAC: the Add button shows ONLY when the role grants 'customers.create'
    // (mirrors the web hiding the "Add Customer" button for view-only roles).
    final canCreate = user?.can('customers', 'create') ?? false;
    final hasFilter = ref.read(customersControllerProvider.notifier).filter.isActive;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Customers'),
        actions: [
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
                final created = await context.push<bool>('/customers/add');
                if (created == true) {
                  ref.read(customersControllerProvider.notifier).refresh();
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

  Widget _body(CustomersState state) {
    switch (state) {
      case CustomersLoading():
        return const LoadingState(message: 'Loading customers…');
      case CustomersError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(customersControllerProvider.notifier).refresh(),
        );
      case CustomersReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No customers found.', icon: Icons.people_outline);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(customersControllerProvider.notifier).refresh(),
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
              final c = items[i];
              return _CustomerCard(
                c,
                onTap: () async {
                  // Tap → detail (View). Refresh on return so an edit / delete
                  // made there is reflected in the list.
                  await context.push('/customers/${c.id}');
                  if (context.mounted) {
                    ref.read(customersControllerProvider.notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard(this.c, {this.onTap});
  final Customer c;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle =
        [c.mobile, c.location].where((s) => s != null && s.isNotEmpty).join(' · ');
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(c.name, style: theme.textTheme.titleMedium),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(subtitle, style: theme.textTheme.bodySmall),
                ],
                if (c.gstNumber != null) ...[
                  const SizedBox(height: 2),
                  Text('GST: ${c.gstNumber}', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (c.status != null) StatusPill(c.status!),
              if (c.creditLimit != null) ...[
                const SizedBox(height: 6),
                Text('Limit ${Fmt.inr(c.creditLimit)}',
                    style: theme.textTheme.bodySmall),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
