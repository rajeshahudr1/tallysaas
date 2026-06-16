import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/payment.dart';
import '../../data/repositories/payment_repository.dart';

/// Async, searchable, paginated list of vouchers (payments OR receipts) for the
/// active company. ONE controller serves both, keyed by `basePath` via a
/// `.family` provider — so `/payments` and `/receipts` reuse identical logic.
@immutable
sealed class VouchersState {
  const VouchersState();
}

class VouchersLoading extends VouchersState {
  const VouchersLoading();
}

class VouchersError extends VouchersState {
  const VouchersError(this.message);
  final String message;
}

class VouchersReady extends VouchersState {
  const VouchersReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Payment> items;
  final bool hasMore;
  final bool loadingMore;

  VouchersReady copyWith({List<Payment>? items, bool? hasMore, bool? loadingMore}) =>
      VouchersReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class VouchersController extends StateNotifier<VouchersState> {
  VouchersController(this._repo, this._basePath) : super(const VouchersLoading()) {
    _reload();
  }

  final PaymentRepository _repo;
  final String _basePath;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Payment> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const VouchersLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(_basePath, page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = VouchersReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = VouchersError(e.message);
    } catch (_) {
      if (mounted) state = const VouchersError('Could not load vouchers. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! VouchersReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

/// Keyed by basePath (`/payments` | `/receipts`) so each gets its own instance.
final vouchersControllerProvider = StateNotifierProvider.autoDispose
    .family<VouchersController, VouchersState, String>((ref, basePath) {
  return VouchersController(ref.watch(paymentRepositoryProvider), basePath);
});
