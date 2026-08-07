import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/tally_ledger.dart';
import '../../data/repositories/tally_ledger_repository.dart';

/// Bucket-list state for Cash / Bank / Payables / Receivables.
@immutable
sealed class LedgersState {
  const LedgersState();
}

class LedgersLoading extends LedgersState {
  const LedgersLoading();
}

class LedgersError extends LedgersState {
  const LedgersError(this.message);
  final String message;
}

class LedgersReady extends LedgersState {
  const LedgersReady({
    required this.rows,
    required this.hasMore,
    this.totalAmount,
    this.totalDc,
    this.loadingMore = false,
  });
  final List<LedgerRow> rows;
  final bool hasMore;
  final num? totalAmount;
  final String? totalDc;
  final bool loadingMore;

  LedgersReady copyWith({
    List<LedgerRow>? rows,
    bool? hasMore,
    num? totalAmount,
    String? totalDc,
    bool? loadingMore,
  }) =>
      LedgersReady(
        rows: rows ?? this.rows,
        hasMore: hasMore ?? this.hasMore,
        totalAmount: totalAmount ?? this.totalAmount,
        totalDc: totalDc ?? this.totalDc,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

/// Balances are PERIOD-derived, so a range is always sent. The default is the
/// current financial year (1 Apr → 31 Mar), which is what the web opens with.
class LedgersController extends StateNotifier<LedgersState> {
  LedgersController(this._repo, this.bucket) : super(const LedgersLoading()) {
    final now = DateTime.now();
    final fyStart = now.month >= 4 ? DateTime(now.year, 4, 1) : DateTime(now.year - 1, 4, 1);
    _from = _fmt.format(fyStart);
    _to = _fmt.format(now);
    _reload();
  }

  final TallyLedgerRepository _repo;
  final LedgerBucket bucket;

  static final _fmt = DateFormat('yyyy-MM-dd');
  static const _perPage = 20;

  late String _from;
  late String _to;
  String get from => _from;
  String get to => _to;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<LedgerRow> _all = [];

  Future<void> setRange(String from, String to) async {
    _from = from;
    _to = to;
    await _reload();
  }

  Future<void> search(String q) async {
    _search = q;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const LedgersLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.bucket(
        bucket,
        from: _from,
        to: _to,
        page: _page,
        perPage: _perPage,
        search: _search,
      );
      _all.addAll(res.rows);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = LedgersReady(
        rows: List.unmodifiable(_all),
        hasMore: _hasMore,
        totalAmount: res.totalAmount,
        totalDc: res.totalDc,
      );
    } on ApiException catch (e) {
      if (mounted) state = LedgersError(e.message);
    } catch (_) {
      if (mounted) {
        state = const LedgersError('Could not load ledgers. Pull to retry.');
      }
    }
  }

  Future<void> loadMore() async {
    final s = state;
    if (s is! LedgersReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final ledgersControllerProvider = StateNotifierProvider.autoDispose
    .family<LedgersController, LedgersState, LedgerBucket>((ref, bucket) {
  return LedgersController(ref.watch(tallyLedgerRepositoryProvider), bucket);
});
