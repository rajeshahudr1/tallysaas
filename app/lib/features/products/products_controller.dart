import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/product.dart';
import '../../data/repositories/product_repository.dart';

/// Async, searchable, paginated list of products for the active company.
/// Same shape as CustomersController (the proven master template).
@immutable
sealed class ProductsState {
  const ProductsState();
}

class ProductsLoading extends ProductsState {
  const ProductsLoading();
}

class ProductsError extends ProductsState {
  const ProductsError(this.message);
  final String message;
}

class ProductsReady extends ProductsState {
  const ProductsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Product> items;
  final bool hasMore;
  final bool loadingMore;

  ProductsReady copyWith({List<Product>? items, bool? hasMore, bool? loadingMore}) =>
      ProductsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class ProductsController extends StateNotifier<ProductsState> {
  ProductsController(this._repo) : super(const ProductsLoading()) {
    _reload();
  }

  final ProductRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Product> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const ProductsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = ProductsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = ProductsError(e.message);
    } catch (_) {
      if (mounted) state = const ProductsError('Could not load products. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! ProductsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final productsControllerProvider =
    StateNotifierProvider.autoDispose<ProductsController, ProductsState>((ref) {
  return ProductsController(ref.watch(productRepositoryProvider));
});
