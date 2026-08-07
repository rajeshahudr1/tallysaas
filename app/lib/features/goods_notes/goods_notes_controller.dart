import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/goods_note.dart';
import '../../data/repositories/goods_note_repository.dart';

/// Async, searchable, paginated list of delivery OR receipt notes — one
/// controller serves both, keyed by [GoodsNoteKind] through a provider family.
@immutable
sealed class GoodsNotesState {
  const GoodsNotesState();
}

class GoodsNotesLoading extends GoodsNotesState {
  const GoodsNotesLoading();
}

class GoodsNotesError extends GoodsNotesState {
  const GoodsNotesError(this.message);
  final String message;
}

class GoodsNotesReady extends GoodsNotesState {
  const GoodsNotesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<GoodsNote> items;
  final bool hasMore;
  final bool loadingMore;

  GoodsNotesReady copyWith({List<GoodsNote>? items, bool? hasMore, bool? loadingMore}) =>
      GoodsNotesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class GoodsNotesController extends StateNotifier<GoodsNotesState> {
  GoodsNotesController(this._repo) : super(const GoodsNotesLoading()) {
    _reload();
  }

  final GoodsNoteRepository _repo;
  static const _perPage = 10;

  String _search = '';
  Map<String, String> _adv = {};
  Map<String, String> get adv => _adv;

  /// The note's own lifecycle tab: all | pending | invoiced | cancelled.
  String _noteStatus = 'all';
  String get noteStatus => _noteStatus;

  int _page = 1;
  bool _hasMore = true;
  final List<GoodsNote> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const GoodsNotesLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page,
        perPage: _perPage,
        search: _search,
        noteStatus: _noteStatus,
        dateFrom: _adv['date_from'],
        dateTo: _adv['date_to'],
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = GoodsNotesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = GoodsNotesError(e.message);
    } catch (_) {
      if (mounted) {
        state = const GoodsNotesError('Could not load notes. Pull to retry.');
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

  Future<void> setNoteStatus(String s) async {
    if (s == _noteStatus) return;
    _noteStatus = s;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! GoodsNotesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final goodsNotesControllerProvider = StateNotifierProvider.autoDispose
    .family<GoodsNotesController, GoodsNotesState, GoodsNoteKind>((ref, kind) {
  return GoodsNotesController(ref.watch(goodsNoteRepositoryProvider(kind)));
});
