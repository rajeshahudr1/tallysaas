import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../data/models/location.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'locations_controller.dart';

/// Locations master — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /locations`.
class LocationsScreen extends ConsumerStatefulWidget {
  const LocationsScreen({super.key});

  @override
  ConsumerState<LocationsScreen> createState() => _LocationsScreenState();
}

class _LocationsScreenState extends ConsumerState<LocationsScreen> {
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
      ref.read(locationsControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(locationsControllerProvider.notifier).search(q);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(locationsControllerProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Locations')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await context.push<bool>('/locations/add');
          if (created == true) {
            ref.read(locationsControllerProvider.notifier).refresh();
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
              hint: 'Search by name, code, city…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(LocationsState state) {
    switch (state) {
      case LocationsLoading():
        return const LoadingState(message: 'Loading locations…');
      case LocationsError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(locationsControllerProvider.notifier).refresh(),
        );
      case LocationsReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No locations found.', icon: Icons.place_outlined);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(locationsControllerProvider.notifier).refresh(),
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
              return _LocationCard(items[i]);
            },
          ),
        );
    }
  }
}

class _LocationCard extends StatelessWidget {
  const _LocationCard(this.l);
  final Location l;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final place = [l.city, l.state].where((x) => x != null && x.isNotEmpty).join(', ');
    final sub = [
      if (l.code != null) 'Code ${l.code}',
      if (place.isNotEmpty) place,
    ].join(' · ');
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(l.name, style: theme.textTheme.titleMedium),
                if (sub.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(sub, style: theme.textTheme.bodySmall),
                ],
                if (l.manager != null) ...[
                  const SizedBox(height: 2),
                  Text('Manager: ${l.manager}', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          if (l.status != null) StatusPill(l.status!),
        ],
      ),
    );
  }
}
