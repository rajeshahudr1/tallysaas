import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/field_dashboard.dart';
import '../../data/repositories/field_repository.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — the salesman's OWN assigned locations (beats), read-only, with tallies.
final _myLocationsProvider = FutureProvider.autoDispose<FieldDashboard>((ref) async {
  return ref.read(fieldRepositoryProvider).myDashboard();
});

class MyLocationsScreen extends ConsumerWidget {
  const MyLocationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_myLocationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My Locations')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading your locations…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load locations.',
          onRetry: () => ref.invalidate(_myLocationsProvider),
        ),
        data: (f) {
          final locs = f.locations;
          if (locs.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(AppSpacing.xl24),
                child: Text('No locations are assigned to you yet.\nAsk your admin to set your beats.',
                    textAlign: TextAlign.center, style: TextStyle(color: AppColors.text2)),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_myLocationsProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.md12),
              itemCount: locs.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _LocationCard(locs[i]),
            ),
          );
        },
      ),
    );
  }
}

class _LocationCard extends StatelessWidget {
  const _LocationCard(this.l);
  final FieldLocation l;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = [l.city, l.state].where((s) => s != null && s.isNotEmpty).join(', ');
    final active = (l.status ?? '').toLowerCase() == 'active';
    Widget metric(String v, String label) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(v, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
            Text(label, style: const TextStyle(fontSize: 10.5, color: AppColors.text3, fontWeight: FontWeight.w600)),
          ],
        );
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Expanded(child: Text(l.name, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: active ? const Color(0xFFDCFCE7) : const Color(0xFFF3F4F6),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(l.status ?? '—',
                    style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700,
                        color: active ? const Color(0xFF166534) : const Color(0xFF6B7280))),
              ),
            ]),
            if (sub.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 2),
                  child: Text(sub, style: const TextStyle(fontSize: 12, color: AppColors.text2))),
            const Divider(height: AppSpacing.lg16),
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              metric(Fmt.num0(l.customers), 'Customers'),
              metric(Fmt.num0(l.invoices), 'My Invoices'),
              metric('₹${Fmt.num0(l.salesValue)}', 'Sales'),
            ]),
          ],
        ),
      ),
    );
  }
}
