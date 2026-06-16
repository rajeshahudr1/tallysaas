import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/location.dart';
import '../../data/repositories/location_repository.dart';

/// Async, searchable, paginated list of locations for the active company.
/// Same shape as CustomersController (the proven master template).
@immutable
sealed class LocationsState {
  const LocationsState();
}

class LocationsLoading extends LocationsState {
  const LocationsLoading();
}

class LocationsError extends LocationsState {
  const LocationsError(this.message);
  final String message;
}

class LocationsReady extends LocationsState {
  const LocationsReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Location> items;
  final bool hasMore;
  final bool loadingMore;

  LocationsReady copyWith({List<Location>? items, bool? hasMore, bool? loadingMore}) =>
      LocationsReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class LocationsController extends StateNotifier<LocationsState> {
  LocationsController(this._repo) : super(const LocationsLoading()) {
    _reload();
  }

  final LocationRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Location> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const LocationsLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = LocationsReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = LocationsError(e.message);
    } catch (_) {
      if (mounted) state = const LocationsError('Could not load locations. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! LocationsReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final locationsControllerProvider =
    StateNotifierProvider.autoDispose<LocationsController, LocationsState>((ref) {
  return LocationsController(ref.watch(locationRepositoryProvider));
});
