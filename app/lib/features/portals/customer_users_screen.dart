import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/models/portal_user.dart';
import '../../data/repositories/portal_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';

/// Customer Users — which of your customers can log in to the portal. A
/// customer with a linked login sees their own invoices and the catalog you
/// scope for them.
class CustomerUsersScreen extends ConsumerStatefulWidget {
  const CustomerUsersScreen({super.key});

  @override
  ConsumerState<CustomerUsersScreen> createState() => _CustomerUsersScreenState();
}

class _CustomerUsersScreenState extends ConsumerState<CustomerUsersScreen> {
  final List<CustomerUser> _rows = [];
  String _search = '';
  int _page = 1;
  bool _hasMore = true;
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;

  static const _perPage = 20;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _page = 1;
      _hasMore = true;
      _rows.clear();
      _loading = true;
      _error = null;
    });
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await ref.read(portalRepositoryProvider).customerUsers(
            page: _page,
            perPage: _perPage,
            search: _search,
          );
      if (!mounted) return;
      setState(() {
        _rows.addAll(res.items);
        _hasMore = res.hasMore;
        _loading = false;
        _loadingMore = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _loading = false; _loadingMore = false; });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Could not load customer users. Pull to retry.';
          _loading = false;
          _loadingMore = false;
        });
      }
    }
  }

  Future<void> _loadMore() async {
    if (!_hasMore || _loadingMore || _loading) return;
    setState(() {
      _loadingMore = true;
      _page += 1;
    });
    await _fetch();
  }

  @override
  Widget build(BuildContext context) {
    return ModuleListScaffold<CustomerUser>(
      title: 'Customer Users',
      infoKey: 'customer-users',
      searchHint: 'Search customers…',
      emptyMessage: 'No customers yet.',
      emptyIcon: Icons.lock_person_outlined,
      items: _rows,
      loading: _loading,
      error: _error,
      hasMore: _hasMore,
      loadingMore: _loadingMore,
      onSearch: (q) {
        _search = q;
        _reload();
      },
      onLoadMore: _loadMore,
      onRefresh: _reload,
      itemBuilder: (context, c) => AppCard(
        onTap: () async {
          final saved = await context.push<bool>('/customer-users/${c.id}');
          if (saved == true) _reload();
        },
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(c.name, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 3),
                  Text(
                    [
                      if (c.email != null) c.email!,
                      if (c.mobile != null) c.mobile!,
                      if (c.group != null) c.group!,
                    ].join('  •  '),
                    style: Theme.of(context).textTheme.bodySmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm8),
            // The one thing this screen exists to answer: can they log in?
            StatusPill(c.hasLogin ? 'Login' : 'No login'),
          ],
        ),
      ),
    );
  }
}
