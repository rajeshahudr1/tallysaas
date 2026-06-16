import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/invoice.dart';
import '../../data/repositories/invoice_repository.dart';

/// Async, searchable, paginated list of PURCHASE invoices for the active
/// company. Same shape as the sales controller; per-page 10.
@immutable
sealed class PurchaseInvoicesState {
  const PurchaseInvoicesState();
}

class PurchaseInvoicesLoading extends PurchaseInvoicesState {
  const PurchaseInvoicesLoading();
}

class PurchaseInvoicesError extends PurchaseInvoicesState {
  const PurchaseInvoicesError(this.message);
  final String message;
}

class PurchaseInvoicesReady extends PurchaseInvoicesState {
  const PurchaseInvoicesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Invoice> items;
  final bool hasMore;
  final bool loadingMore;

  PurchaseInvoicesReady copyWith({List<Invoice>? items, bool? hasMore, bool? loadingMore}) =>
      PurchaseInvoicesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class PurchaseInvoicesController extends StateNotifier<PurchaseInvoicesState> {
  PurchaseInvoicesController(this._repo) : super(const PurchaseInvoicesLoading()) {
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
    if (mounted) state = const PurchaseInvoicesLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.listPurchase(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = PurchaseInvoicesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = PurchaseInvoicesError(e.message);
    } catch (_) {
      if (mounted) state = const PurchaseInvoicesError('Could not load invoices. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! PurchaseInvoicesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final purchaseInvoicesControllerProvider =
    StateNotifierProvider.autoDispose<PurchaseInvoicesController, PurchaseInvoicesState>((ref) {
  return PurchaseInvoicesController(ref.watch(invoiceRepositoryProvider));
});
