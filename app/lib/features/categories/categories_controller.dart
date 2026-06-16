import 'package:flutter/foundation.dart' show immutable;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/category.dart';
import '../../data/repositories/category_repository.dart';

/// Async, searchable, paginated list of categories for the active company.
/// Same shape as CustomersController (the proven master template).
@immutable
sealed class CategoriesState {
  const CategoriesState();
}

class CategoriesLoading extends CategoriesState {
  const CategoriesLoading();
}

class CategoriesError extends CategoriesState {
  const CategoriesError(this.message);
  final String message;
}

class CategoriesReady extends CategoriesState {
  const CategoriesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Category> items;
  final bool hasMore;
  final bool loadingMore;

  CategoriesReady copyWith({List<Category>? items, bool? hasMore, bool? loadingMore}) =>
      CategoriesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class CategoriesController extends StateNotifier<CategoriesState> {
  CategoriesController(this._repo) : super(const CategoriesLoading()) {
    _reload();
  }

  final CategoryRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Category> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const CategoriesLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = CategoriesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = CategoriesError(e.message);
    } catch (_) {
      if (mounted) state = const CategoriesError('Could not load categories. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! CategoriesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final categoriesControllerProvider =
    StateNotifierProvider.autoDispose<CategoriesController, CategoriesState>((ref) {
  return CategoriesController(ref.watch(categoryRepositoryProvider));
});
