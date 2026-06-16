import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../data/models/sales_person.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'sales_persons_controller.dart';

/// Sales Persons master — searchable, paginated list with pull-to-refresh,
/// infinite scroll, and a + button to add. Data from `GET /sales-persons`.
class SalesPersonsScreen extends ConsumerStatefulWidget {
  const SalesPersonsScreen({super.key});

  @override
  ConsumerState<SalesPersonsScreen> createState() => _SalesPersonsScreenState();
}

class _SalesPersonsScreenState extends ConsumerState<SalesPersonsScreen> {
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
      ref.read(salesPersonsControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(salesPersonsControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(salesPersonsControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Sales Persons')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/sales-persons/add');
          if (created == true) {
            ref.read(salesPersonsControllerProvider.notifier).refresh();
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
              hint: 'Search by name, code, mobile…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(SalesPersonsState state) {
    switch (state) {
      case SalesPersonsLoading():
        return const LoadingState(message: 'Loading sales persons…');
      case SalesPersonsError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(salesPersonsControllerProvider.notifier).refresh(),
        );
      case SalesPersonsReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No sales persons found.', icon: Icons.badge_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(salesPersonsControllerProvider.notifier).refresh(),
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
              return _SalesPersonCard(items[i]);
            },
          ),
        );
    }
  }
}

class _SalesPersonCard extends StatelessWidget {
  const _SalesPersonCard(this.s);
  final SalesPerson s;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = [
      if (s.employeeCode != null) s.employeeCode!,
      if (s.mobile != null) s.mobile!,
    ].join(' · ');
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.name, style: theme.textTheme.titleMedium),
                if (sub.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(sub, style: theme.textTheme.bodySmall),
                ],
                if (s.email != null) ...[
                  const SizedBox(height: 2),
                  Text(s.email!, style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          if (s.status != null) StatusPill(s.status!),
        ],
      ),
    );
  }
}
