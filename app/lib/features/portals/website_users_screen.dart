import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../data/models/portal_user.dart';
import '../../data/repositories/portal_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';

/// Website Users — third-party API consumers. Each one is a customers row with
/// a login and an api_token, plus its own cash / online price uplifts.
class WebsiteUsersScreen extends ConsumerStatefulWidget {
  const WebsiteUsersScreen({super.key});

  @override
  ConsumerState<WebsiteUsersScreen> createState() => _WebsiteUsersScreenState();
}

class _WebsiteUsersScreenState extends ConsumerState<WebsiteUsersScreen> {
  final List<WebsiteUser> _rows = [];
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
      final res = await ref.read(portalRepositoryProvider).websiteUsers(
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
          _error = 'Could not load website users. Pull to retry.';
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

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  /// A regenerated token is shown ONCE — the API never hands it back again, so
  /// it goes straight into a copyable dialog.
  Future<void> _regenerate(WebsiteUser u) async {
    final ok = await ConfirmDialog.show(
      context,
      title: 'Regenerate API token?',
      message: 'The current token stops working immediately. Anything using it '
          'must be updated with the new one.',
      confirmLabel: 'Regenerate',
      danger: true,
    );
    if (ok != true) return;

    try {
      final token = await ref.read(portalRepositoryProvider).regenerateToken(u.id);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('New API token'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(token ?? '—'),
              const SizedBox(height: AppSpacing.sm8),
              Text(
                'Copy it now — it is not shown again.',
                style: Theme.of(ctx).textTheme.bodySmall,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: token ?? ''));
                if (ctx.mounted) Navigator.pop(ctx);
                _snack('Token copied.');
              },
              child: const Text('Copy'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Done'),
            ),
          ],
        ),
      );
      _reload();
    } on ApiException catch (e) {
      _snack(e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('website-users', 'create') ?? false;
    final canEdit = user?.can('website-users', 'edit') ?? false;
    final theme = Theme.of(context);

    return ModuleListScaffold<WebsiteUser>(
      title: 'Website Users',
      infoKey: 'website-users',
      searchHint: 'Search website users…',
      emptyMessage: 'No website users yet.',
      emptyIcon: Icons.public,
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
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: 'website-user-new',
              onPressed: () async {
                final created = await context.push<bool>('/website-users/add');
                if (created == true) _reload();
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      itemBuilder: (context, u) => AppCard(
        onTap: () async {
          final saved = await context.push<bool>('/website-users/${u.id}/edit');
          if (saved == true) _reload();
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(u.name, style: theme.textTheme.titleMedium),
                      const SizedBox(height: 3),
                      Text(
                        [
                          if (u.email != null) u.email!,
                          if (u.mobile != null) u.mobile!,
                        ].join('  •  '),
                        style: theme.textTheme.bodySmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                StatusPill(u.status ?? 'Active'),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            Text(
              'Cash +${u.cashExtraPct ?? 0}%   •   Online +${u.onlineExtraPct ?? 0}%',
              style: theme.textTheme.bodySmall,
            ),
            if (canEdit) ...[
              const Divider(height: AppSpacing.xl24),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: () => _regenerate(u),
                  icon: const Icon(Icons.key_outlined, size: 18),
                  label: const Text('Regenerate token'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
