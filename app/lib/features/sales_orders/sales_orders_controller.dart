import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/sales_order.dart';
import '../../data/repositories/sales_order_repository.dart';

/// Async, searchable, paginated list of sales orders — the standard list
/// controller shape every module uses.
@immutable
sealed class SalesOrdersState {
  const SalesOrdersState();
}

class SalesOrdersLoading extends SalesOrdersState {
  const SalesOrdersLoading();
}

class SalesOrdersError extends SalesOrdersState {
  const SalesOrdersError(this.message);
  final String message;
}

class SalesOrdersReady extends SalesOrdersState {
  const SalesOrdersReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<SalesOrder> items;
  final bool hasMore;
  final bool loadingMore;

  SalesOrdersReady copyWith({List<SalesOrder>? items, bool? hasMore, bool? loadingMore}) =>
      SalesOrdersReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class SalesOrdersController extends StateNotifier<SalesOrdersState> {
  SalesOrdersController(this._repo, {this.mine = false})
      : super(const SalesOrdersLoading()) {
    _reload();
  }

  final SalesOrderRepository _repo;

  /// Scope to the signed-in user's own orders (`?mine=1`).
  final bool mine;

  static const _perPage = 10;

  String _search = '';
  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;

  /// DELIVERY lifecycle tab: all | pending | partially_delivered | delivered |
  /// cancelled.
  String _orderStatus = 'all';
  String get orderStatus => _orderStatus;

  int _page = 1;
  bool _hasMore = true;
  final List<SalesOrder> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const SalesOrdersLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page,
        perPage: _perPage,
        search: _search,
        orderStatus: _orderStatus,
        dateFrom: _adv['date_from'],
        dateTo: _adv['date_to'],
        mine: mine,
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = SalesOrdersReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = SalesOrdersError(e.message);
    } catch (_) {
      if (mounted) {
        state = const SalesOrdersError('Could not load sales orders. Pull to retry.');
      }
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> setAdvFilter(Map<String, String> f) async {
    _adv = f;
    await _reload();
  }

  Future<void> setOrderStatus(String s) async {
    if (s == _orderStatus) return;
    _orderStatus = s;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! SalesOrdersReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final salesOrdersControllerProvider =
    StateNotifierProvider.autoDispose<SalesOrdersController, SalesOrdersState>((ref) {
  return SalesOrdersController(ref.watch(salesOrderRepositoryProvider));
});
