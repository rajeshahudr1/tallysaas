import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/journal.dart';
import '../../data/repositories/journal_repository.dart';

/// Async, searchable, paginated list of journal vouchers for the active company.
@immutable
sealed class JournalsState {
  const JournalsState();
}

class JournalsLoading extends JournalsState {
  const JournalsLoading();
}

class JournalsError extends JournalsState {
  const JournalsError(this.message);
  final String message;
}

class JournalsReady extends JournalsState {
  const JournalsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Journal> items;
  final bool hasMore;
  final bool loadingMore;

  JournalsReady copyWith({List<Journal>? items, bool? hasMore, bool? loadingMore}) =>
      JournalsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class JournalsController extends StateNotifier<JournalsState> {
  JournalsController(this._repo) : super(const JournalsLoading()) {
    _reload();
  }

  final JournalRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Journal> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const JournalsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = JournalsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = JournalsError(e.message);
    } catch (_) {
      if (mounted) state = const JournalsError('Could not load journals. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! JournalsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final journalsControllerProvider =
    StateNotifierProvider.autoDispose<JournalsController, JournalsState>((ref) {
  return JournalsController(ref.watch(journalRepositoryProvider));
});
