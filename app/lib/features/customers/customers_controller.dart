import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/customer.dart';
import '../../data/repositories/customer_repository.dart';
import '../../features/customers/customer_filter_sheet.dart';

/// Async, searchable, paginated list of customers for the active company.
@immutable
sealed class CustomersState {
  const CustomersState();
}

class CustomersLoading extends CustomersState {
  const CustomersLoading();
}

class CustomersError extends CustomersState {
  const CustomersError(this.message);
  final String message;
}

class CustomersReady extends CustomersState {
  const CustomersReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Customer> items;
  final bool hasMore;
  final bool loadingMore;

  CustomersReady copyWith({List<Customer>? items, bool? hasMore, bool? loadingMore}) =>
      CustomersReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class CustomersController extends StateNotifier<CustomersState> {
  CustomersController(this._repo) : super(const CustomersLoading()) {
    _reload();
  }

  final CustomerRepository _repo;
  static const _perPage = 20;

  CustomerFilter _filter = const CustomerFilter();
  CustomerFilter get filter => _filter;
  String? _ymd(DateTime? d) => d == null
      ? null
      : '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  /// Which Parties tab is showing: 'all' | 'active' | 'favourite'. Kept
  /// separate from the advanced filter so opening the filter sheet does not
  /// silently drop the tab, and switching tab does not drop their filters.
  String _tab = 'all';
  String get tab => _tab;

  /// The window "Recent Active" means. Matches the Inactive Customers tile
  /// on the dashboard, so the two can never disagree about who is active.
  static const int activeDays = 90;

  int _page = 1;
  bool _hasMore = true;
  final List<Customer> _all = [];

  /// Fresh load — page 1, replacing the list (used on first mount, search, pull-to-refresh).
  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const CustomersLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(
        page: _page, perPage: _perPage,
        search: _filter.search, status: _filter.status,
        location: _filter.location, salesPerson: _filter.salesPerson,
        customerGroup: _filter.customerGroup, gst: _filter.gst,
        createdFrom: _ymd(_filter.from), createdTo: _ymd(_filter.to),
        favourite: _tab == 'favourite',
        activeDays: _tab == 'active' ? activeDays : null,
      );
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = CustomersReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = CustomersError(e.message);
    } catch (_) {
      if (mounted) state = const CustomersError('Could not load customers. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _filter = _filter.copyWith(search: query.trim().isEmpty ? null : query.trim());
    await _reload();
  }

  /// Apply the full advanced filter. Re-loads from page 1.
  Future<void> setFilter(CustomerFilter f) async {
    _filter = f;
    await _reload();
  }

  /// Switch the All / Recent Active / Favourite tab. Re-loads from page 1 —
  /// staying on page 7 of All when Favourite holds two rows shows an empty
  /// list that reads as "no favourites".
  Future<void> setTab(String tab) async {
    if (_tab == tab) return;
    _tab = tab;
    await _reload();
  }

  /// Star / unstar a party.
  ///
  /// The row is updated on screen FIRST and the call made after: a star is
  /// a one-tap gesture and waiting on a round trip before the icon moves
  /// makes it feel broken. If the call fails the row is put back, so the
  /// screen never keeps a state the server rejected.
  Future<bool> toggleFavourite(int id) async {
    final i = _all.indexWhere((c) => c.id == id);
    if (i < 0) return false;
    final want = !_all[i].isFavourite;
    _apply(i, want);
    try {
      await _repo.setFavourite(id, want);
    } catch (_) {
      _apply(i, !want);
      return false;
    }
    // On the Favourite tab an unstarred party no longer belongs here.
    if (_tab == 'favourite' && !want) await _reload();
    return true;
  }

  void _apply(int i, bool on) {
    _all[i] = _all[i].copyWith(isFavourite: on);
    if (!mounted) return;
    final s = state;
    state = CustomersReady(
      items: List.unmodifiable(_all),
      hasMore: _hasMore,
      loadingMore: s is CustomersReady && s.loadingMore,
    );
  }
  Future<void> refresh() => _reload();

  /// Append the next page (infinite scroll). No-op while a page is in flight
  /// or when the last page has been reached.
  Future<void> loadMore() async {
    final s = state;
    if (s is! CustomersReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final customersControllerProvider =
    StateNotifierProvider.autoDispose<CustomersController, CustomersState>((ref) {
  return CustomersController(ref.watch(customerRepositoryProvider));
});
