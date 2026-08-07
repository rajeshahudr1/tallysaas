import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/quotation.dart';
import '../../data/repositories/quotation_repository.dart';

/// Async, searchable, paginated list of quotations for the active company.
/// Same shape as [SalesInvoicesController] — the standard list controller every
/// module copies. Per-page 10 (the API's voucher default).
@immutable
sealed class QuotationsState {
  const QuotationsState();
}

class QuotationsLoading extends QuotationsState {
  const QuotationsLoading();
}

class QuotationsError extends QuotationsState {
  const QuotationsError(this.message);
  final String message;
}

class QuotationsReady extends QuotationsState {
  const QuotationsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Quotation> items;
  final bool hasMore;
  final bool loadingMore;

  QuotationsReady copyWith({List<Quotation>? items, bool? hasMore, bool? loadingMore}) =>
      QuotationsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class QuotationsController extends StateNotifier<QuotationsState> {
  QuotationsController(this._repo, {this.mine = false})
      : super(const QuotationsLoading()) {
    _reload();
  }

  final QuotationRepository _repo;

  /// "My Quotations" — the salesman's own rows only (mirrors `?mine=1`).
  final bool mine;

  static const _perPage = 10;

  String _search = '';
  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;

  /// DEAL lifecycle tab: 'all' | 'open' | 'accepted' | 'rejected' | 'expired'.
  String _quoteStatus = 'all';
  String get quoteStatus => _quoteStatus;

  int _page = 1;
  bool _hasMore = true;
  final List<Quotation> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const QuotationsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page,
        perPage: _perPage,
        search: _search,
        quoteStatus: _quoteStatus,
        dateFrom: _adv['date_from'],
        dateTo: _adv['date_to'],
        mine: mine,
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = QuotationsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = QuotationsError(e.message);
    } catch (_) {
      if (mounted) {
        state = const QuotationsError('Could not load quotations. Pull to retry.');
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

  /// Switch the deal-status tab and reload.
  Future<void> setQuoteStatus(String s) async {
    if (s == _quoteStatus) return;
    _quoteStatus = s;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! QuotationsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final quotationsControllerProvider =
    StateNotifierProvider.autoDispose<QuotationsController, QuotationsState>((ref) {
  return QuotationsController(ref.watch(quotationRepositoryProvider));
});

/// "My Quotations" (the My Entries menu) — the same list scoped to `?mine=1`.
final myQuotationsControllerProvider =
    StateNotifierProvider.autoDispose<QuotationsController, QuotationsState>((ref) {
  return QuotationsController(ref.watch(quotationRepositoryProvider), mine: true);
});
