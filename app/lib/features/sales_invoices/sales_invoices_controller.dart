import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/invoice.dart';
import '../../data/repositories/invoice_repository.dart';

/// Async, searchable, paginated list of SALES invoices for the active company.
/// Same shape as the master controllers; per-page 10 (the API's invoice default).
@immutable
sealed class SalesInvoicesState {
  const SalesInvoicesState();
}

class SalesInvoicesLoading extends SalesInvoicesState {
  const SalesInvoicesLoading();
}

class SalesInvoicesError extends SalesInvoicesState {
  const SalesInvoicesError(this.message);
  final String message;
}

class SalesInvoicesReady extends SalesInvoicesState {
  const SalesInvoicesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Invoice> items;
  final bool hasMore;
  final bool loadingMore;

  SalesInvoicesReady copyWith({List<Invoice>? items, bool? hasMore, bool? loadingMore}) =>
      SalesInvoicesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class SalesInvoicesController extends StateNotifier<SalesInvoicesState> {
  SalesInvoicesController(this._repo) : super(const SalesInvoicesLoading()) {
    _reload();
  }

  final InvoiceRepository _repo;
  static const _perPage = 10;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Invoice> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const SalesInvoicesLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.listSales(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = SalesInvoicesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = SalesInvoicesError(e.message);
    } catch (_) {
      if (mounted) state = const SalesInvoicesError('Could not load invoices. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! SalesInvoicesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final salesInvoicesControllerProvider =
    StateNotifierProvider.autoDispose<SalesInvoicesController, SalesInvoicesState>((ref) {
  return SalesInvoicesController(ref.watch(invoiceRepositoryProvider));
});
