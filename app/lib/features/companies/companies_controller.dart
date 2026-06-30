import 'package:flutter/foundation.dart' show immutable;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../data/models/company.dart';
import '../../data/repositories/company_repository.dart';

/// Async, searchable, paginated list of companies for the active tenant.
/// Same shape as the other master controllers.
@immutable
sealed class CompaniesState {
  const CompaniesState();
}

class CompaniesLoading extends CompaniesState {
  const CompaniesLoading();
}

class CompaniesError extends CompaniesState {
  const CompaniesError(this.message);
  final String message;
}

class CompaniesReady extends CompaniesState {
  const CompaniesReady({
    required this.items,
    required this.hasMore,
    this.loadingMore = false,
  });
  final List<Company> items;
  final bool hasMore;
  final bool loadingMore;

  CompaniesReady copyWith({List<Company>? items, bool? hasMore, bool? loadingMore}) =>
      CompaniesReady(
        items: items ?? this.items,
        hasMore: hasMore ?? this.hasMore,
        loadingMore: loadingMore ?? this.loadingMore,
      );
}

class CompaniesController extends StateNotifier<CompaniesState> {
  CompaniesController(this._repo) : super(const CompaniesLoading()) {
    _reload();
  }

  final CompanyRepository _repo;
  static const _perPage = 20;

  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  final List<Company> _all = [];

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const CompaniesLoading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await _repo.list(page: _page, perPage: _perPage, search: _search);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      if (!mounted) return;
      state = CompaniesReady(items: List.unmodifiable(_all), hasMore: _hasMore);
    } on ApiException catch (e) {
      if (mounted) state = CompaniesError(e.message);
    } catch (_) {
      if (mounted) state = const CompaniesError('Could not load companies. Pull to retry.');
    }
  }

  Future<void> search(String query) async {
    _search = query;
    await _reload();
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    final s = state;
    if (s is! CompaniesReady || !_hasMore || s.loadingMore) return;
    state = s.copyWith(loadingMore: true);
    _page += 1;
    await _fetch();
  }
}

final companiesControllerProvider =
    StateNotifierProvider.autoDispose<CompaniesController, CompaniesState>((ref) {
  return CompaniesController(ref.watch(companyRepositoryProvider));
});
