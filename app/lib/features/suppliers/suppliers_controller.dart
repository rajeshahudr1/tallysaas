import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/supplier.dart';
import '../../data/repositories/supplier_repository.dart';

/// Async, searchable, paginated list of suppliers for the active company.
/// Same shape as CustomersController (the proven master template).
@immutable
sealed class SuppliersState {
  const SuppliersState();
}

class SuppliersLoading extends SuppliersState {
  const SuppliersLoading();
}

class SuppliersError extends SuppliersState {
  const SuppliersError(this.message);
  final String message;
}

class SuppliersReady extends SuppliersState {
  const SuppliersReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Supplier> items;
  final bool hasMore;
  final bool loadingMore;

  SuppliersReady copyWith({List<Supplier>? items, bool? hasMore, bool? loadingMore}) =>
      SuppliersReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class SuppliersController extends StateNotifier<SuppliersState> {
  SuppliersController(this._repo) : super(const SuppliersLoading()) {
    _reload();
  }

  final SupplierRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Supplier> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const SuppliersLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = SuppliersReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = SuppliersError(e.message);
    } catch (_) {
      if (mounted) state = const SuppliersError('Could not load suppliers. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! SuppliersReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final suppliersControllerProvider =
    StateNotifierProvider.autoDispose<SuppliersController, SuppliersState>((ref) {
  return SuppliersController(ref.watch(supplierRepositoryProvider));
});
