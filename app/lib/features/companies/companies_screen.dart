import 'dart:async';

import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../data/models/company.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'companies_controller.dart';

/// Companies master — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and an Add button gated by `companies.create`. Data from
/// `GET /companies`. Tap a card → detail (View).
class CompaniesScreen extends ConsumerStatefulWidget {
  const CompaniesScreen({super.key});

  @override
  ConsumerState<CompaniesScreen> createState() => _CompaniesScreenState();
}

class _CompaniesScreenState extends ConsumerState<CompaniesScreen> {
  final _searchCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _scrollCtl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtl.dispose();
    _scrollCtl.removeListener(_onScroll);
    _scrollCtl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtl.position.pixels >= _scrollCtl.position.maxScrollExtent - 240) {
      ref.read(companiesControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(companiesControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(companiesControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('companies', 'create') ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Companies'), actions: const [ModuleInfoButton('companies')]),
      floatingActionButton: !canCreate
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final created = await context.push<bool>('/companies/add');
                if (created == true) {
                  ref.read(companiesControllerProvider.notifier).refresh();
                }
              },
              icon: const Icon(Icons.add),
              label: const Text('Add'),
            ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by name, GST…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(CompaniesState state) {
    switch (state) {
      case CompaniesLoading():
        return const LoadingState(message: 'Loading companies…');
      case CompaniesError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(companiesControllerProvider.notifier).refresh(),
        );
      case CompaniesReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No companies found.', icon: Icons.business_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(companiesControllerProvider.notifier).refresh(),
          child: ListView.separated(
            controller: _scrollCtl,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32,
            ),
            itemCount: items.length + (hasMore ? 1 : 0),
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              if (i >= items.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg16),
                  child: Center(
                    child: loadingMore
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : const SizedBox.shrink(),
                  ),
                );
              }
              final c = items[i];
              return _CompanyCard(
                c,
                onTap: () async {
                  await context.push('/companies/${c.id}');
                  if (context.mounted) {
                    ref.read(companiesControllerProvider.notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
  }
}

class _CompanyCard extends StatelessWidget {
  const _CompanyCard(this.c, {this.onTap});
  final Company c;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = [
      if (c.mobile != null) c.mobile!,
      if (c.state != null) c.state!,
    ].join(' · ');
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(c.name, style: theme.textTheme.titleMedium),
                if (sub.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(sub, style: theme.textTheme.bodySmall),
                ],
                if (c.gstNumber != null) ...[
                  const SizedBox(height: 2),
                  Text('GST: ${c.gstNumber}', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          if (c.status != null) StatusPill(c.status!),
        ],
      ),
    );
  }
}
