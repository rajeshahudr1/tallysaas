import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../data/models/category.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'categories_controller.dart';

/// Categories master — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /categories`.
class CategoriesScreen extends ConsumerStatefulWidget {
  const CategoriesScreen({super.key});

  @override
  ConsumerState<CategoriesScreen> createState() => _CategoriesScreenState();
}

class _CategoriesScreenState extends ConsumerState<CategoriesScreen> {
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
      ref.read(categoriesControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(categoriesControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(categoriesControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Categories')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/categories/add');
          if (created == true) {
            ref.read(categoriesControllerProvider.notifier).refresh();
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
              hint: 'Search categories…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(CategoriesState state) {
    switch (state) {
      case CategoriesLoading():
        return const LoadingState(message: 'Loading categories…');
      case CategoriesError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(categoriesControllerProvider.notifier).refresh(),
        );
      case CategoriesReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No categories found.', icon: Icons.category_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(categoriesControllerProvider.notifier).refresh(),
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
              return _CategoryCard(items[i]);
            },
          ),
        );
    }
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard(this.c);
  final Category c;

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
                Text(c.name, style: theme.textTheme.titleMedium),
                if (c.parent != null) ...[
                  const SizedBox(height: 3),
                  Text('Under ${c.parent}', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          if (c.status != null) StatusPill(c.status!),
        ],
      ),
    );
  }
}
