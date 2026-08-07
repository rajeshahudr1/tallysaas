import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/payment_request.dart';
import '../../data/repositories/collect_payment_repository.dart';

/// Paginated list of payment requests, filtered by status.
@immutable
sealed class CollectPaymentsState {
  const CollectPaymentsState();
}

class CollectPaymentsLoading extends CollectPaymentsState {
  const CollectPaymentsLoading();
}

class CollectPaymentsError extends CollectPaymentsState {
  const CollectPaymentsError(this.message);
  final String message;
}

class CollectPaymentsReady extends CollectPaymentsState {
  const CollectPaymentsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<PaymentRequest> items;
  final bool hasMore;
  final bool loadingMore;

  CollectPaymentsReady copyWith({
    List<PaymentRequest>? items,
    bool? hasMore,
    bool? loadingMore,
  }) =>
      CollectPaymentsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class CollectPaymentsController extends StateNotifier<CollectPaymentsState> {
  CollectPaymentsController(this._repo) : super(const CollectPaymentsLoading()) {
    _reload();
  }

  final CollectPaymentRepository _repo;
  static const _perPage = 10;

  String _status = 'all';
  String get status => _status;

  int _page = 1;
  bool _hasMore = true;
  final List<PaymentRequest> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const CollectPaymentsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, status: _status);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = CollectPaymentsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = CollectPaymentsError(e.message);
    } catch (_) {
      if (mounted) {
        state = const CollectPaymentsError(
            'Could not load payment requests. Pull to retry.');
      }
    }
  }

  Future<void> setStatus(String s) async {
    if (s == _status) return;
    _status = s;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! CollectPaymentsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final collectPaymentsControllerProvider = StateNotifierProvider.autoDispose<
    CollectPaymentsController, CollectPaymentsState>((ref) {
  return CollectPaymentsController(ref.watch(collectPaymentRepositoryProvider));
});

/// The company's Collect Payments settings — read by the list screen (to warn
/// when the feature is off) and edited on the settings screen.
final collectPaymentSettingsProvider =
    FutureProvider.autoDispose<CollectPaymentSettings>((ref) {
  return ref.watch(collectPaymentRepositoryProvider).settings();
});

/// The outstanding-invoice pick-list for a new request.
final outstandingInvoicesProvider =
    FutureProvider.autoDispose<List<OutstandingInvoice>>((ref) {
  return ref.watch(collectPaymentRepositoryProvider).outstandingInvoices();
});
