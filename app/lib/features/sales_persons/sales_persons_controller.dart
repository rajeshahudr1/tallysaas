import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/sales_person.dart';
import '../../data/repositories/sales_person_repository.dart';

/// Async, searchable, paginated list of sales persons for the active company.
/// Same shape as CustomersController (the proven master template).
@immutable
sealed class SalesPersonsState {
  const SalesPersonsState();
}

class SalesPersonsLoading extends SalesPersonsState {
  const SalesPersonsLoading();
}

class SalesPersonsError extends SalesPersonsState {
  const SalesPersonsError(this.message);
  final String message;
}

class SalesPersonsReady extends SalesPersonsState {
  const SalesPersonsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<SalesPerson> items;
  final bool hasMore;
  final bool loadingMore;

  SalesPersonsReady copyWith({List<SalesPerson>? items, bool? hasMore, bool? loadingMore}) =>
      SalesPersonsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class SalesPersonsController extends StateNotifier<SalesPersonsState> {
  SalesPersonsController(this._repo) : super(const SalesPersonsLoading()) {
    _reload();
  }

  final SalesPersonRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<SalesPerson> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const SalesPersonsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = SalesPersonsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = SalesPersonsError(e.message);
    } catch (_) {
      if (mounted) state = const SalesPersonsError('Could not load sales persons. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! SalesPersonsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final salesPersonsControllerProvider =
    StateNotifierProvider.autoDispose<SalesPersonsController, SalesPersonsState>((ref) {
  return SalesPersonsController(ref.watch(salesPersonRepositoryProvider));
});
