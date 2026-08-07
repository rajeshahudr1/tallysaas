import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/return_note.dart';
import '../../data/repositories/return_note_repository.dart';

/// Async, searchable, paginated list of credit OR debit notes — one controller
/// serves both, keyed by [ReturnNoteKind] through a provider family.
@immutable
sealed class ReturnNotesState {
  const ReturnNotesState();
}

class ReturnNotesLoading extends ReturnNotesState {
  const ReturnNotesLoading();
}

class ReturnNotesError extends ReturnNotesState {
  const ReturnNotesError(this.message);
  final String message;
}

class ReturnNotesReady extends ReturnNotesState {
  const ReturnNotesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<ReturnNote> items;
  final bool hasMore;
  final bool loadingMore;

  ReturnNotesReady copyWith({List<ReturnNote>? items, bool? hasMore, bool? loadingMore}) =>
      ReturnNotesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class ReturnNotesController extends StateNotifier<ReturnNotesState> {
  ReturnNotesController(this._repo) : super(const ReturnNotesLoading()) {
    _reload();
  }

  final ReturnNoteRepository _repo;
  static const _perPage = 10;

  String _search = '';
  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;

  int _page = 1;
  bool _hasMore = true;
  final List<ReturnNote> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const ReturnNotesLoading();
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
      state = ReturnNotesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = ReturnNotesError(e.message);
    } catch (_) {
      if (mounted) {
        state = const ReturnNotesError('Could not load notes. Pull to retry.');
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
    if (s is! ReturnNotesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final returnNotesControllerProvider = StateNotifierProvider.autoDispose
    .family<ReturnNotesController, ReturnNotesState, ReturnNoteKind>((ref, kind) {
  return ReturnNotesController(ref.watch(returnNoteRepositoryProvider(kind)));
});
