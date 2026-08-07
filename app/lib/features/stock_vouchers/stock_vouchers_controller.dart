import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/stock_voucher.dart';
import '../../data/repositories/stock_voucher_repository.dart';

/// Paginated list state shared by both stock vouchers. They are separate
/// endpoints with different row shapes, so the state is generic over [T] rather
/// than duplicated twice.
@immutable
sealed class StockListState<T> {
  const StockListState();
}

class StockListLoading<T> extends StockListState<T> {
  const StockListLoading();
}

class StockListError<T> extends StockListState<T> {
  const StockListError(this.message);
  final String message;
}

class StockListReady<T> extends StockListState<T> {
  const StockListReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<T> items;
  final bool hasMore;
  final bool loadingMore;

  StockListReady<T> copyWith({List<T>? items, bool? hasMore, bool? loadingMore}) =>
      StockListReady<T>(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

/// Stock journals — searchable, date-filterable, paginated.
class StockJournalsController extends StateNotifier<StockListState<StockJournal>> {
  StockJournalsController(this._repo) : super(const StockListLoading()) {
    _reload();
  }

  final StockJournalRepository _repo;
  static const _perPage = 10;

  String _search = '';
  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;
  int _page = 1;
  bool _hasMore = true;
  final List<StockJournal> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const StockListLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page,
        perPage: _perPage,
        search: _search,
        dateFrom: _adv['date_from'],
        dateTo: _adv['date_to'],
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = StockListReady<StockJournal>(
        items: List.unmodifiable(_all),
        hasMore: _hasMore,
      );
    } on ApiException catch (e) {
      if (mounted) state = StockListError(e.message);
    } catch (_) {
      if (mounted) {
        state = const StockListError('Could not load stock journals. Pull to retry.');
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

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! StockListReady<StockJournal> || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

/// Physical-stock sheets — date-filterable and paginated. The API has no search
/// on this endpoint (a sheet has no party or narration to match), so the list
/// screen's search box is hidden.
class PhysicalStockController extends StateNotifier<StockListState<PhysicalStockSheet>> {
  PhysicalStockController(this._repo) : super(const StockListLoading()) {
    _reload();
  }

  final PhysicalStockRepository _repo;
  static const _perPage = 10;

  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;
  int _page = 1;
  bool _hasMore = true;
  final List<PhysicalStockSheet> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const StockListLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page,
        perPage: _perPage,
        dateFrom: _adv['date_from'],
        dateTo: _adv['date_to'],
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = StockListReady<PhysicalStockSheet>(
        items: List.unmodifiable(_all),
        hasMore: _hasMore,
      );
    } on ApiException catch (e) {
      if (mounted) state = StockListError(e.message);
    } catch (_) {
      if (mounted) {
        state = const StockListError('Could not load stock sheets. Pull to retry.');
      }
    }
  }

  Future<void> setAdvFilter(Map<String, String> f) async {
    _adv = f;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! StockListReady<PhysicalStockSheet> || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final stockJournalsControllerProvider = StateNotifierProvider.autoDispose<
    StockJournalsController, StockListState<StockJournal>>((ref) {
  return StockJournalsController(ref.watch(stockJournalRepositoryProvider));
});

final physicalStockControllerProvider = StateNotifierProvider.autoDispose<
    PhysicalStockController, StockListState<PhysicalStockSheet>>((ref) {
  return PhysicalStockController(ref.watch(physicalStockRepositoryProvider));
});
