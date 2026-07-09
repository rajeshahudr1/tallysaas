import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/models/customer.dart';
import '../../data/repositories/customer_repository.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — the salesman's OWN assigned customers, read-only. /customers is
/// assignment-scoped server-side, so this lists ONLY their assigned customers.
final _myCustomersProvider = FutureProvider.autoDispose<List<Customer>>((ref) async {
  final paged = await ref.read(customerRepositoryProvider).list(perPage: 100);
  return paged.items;
});

class MyCustomersScreen extends ConsumerWidget {
  const MyCustomersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_myCustomersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My Customers')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading your customers…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load customers.',
          onRetry: () => ref.invalidate(_myCustomersProvider),
        ),
        data: (rows) {
          if (rows.isEmpty) {
            return const _Empty(icon: Icons.person_off_outlined, text: 'No customers assigned to you yet.');
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_myCustomersProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.md12),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _CustomerCard(rows[i]),
            ),
          );
        },
      ),
    );
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard(this.c);
  final Customer c;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Widget row(IconData ic, String? v) => (v == null || v.trim().isEmpty)
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(children: [
              Icon(ic, size: 15, color: AppColors.text3),
              const SizedBox(width: 8),
              Expanded(child: Text(v, style: theme.textTheme.bodySmall)),
            ]),
          );
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(c.name, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
            row(Icons.phone_outlined, c.mobile),
            row(Icons.email_outlined, c.email),
            row(Icons.location_on_outlined, c.location),
            row(Icons.receipt_long_outlined, c.gstNumber),
            row(Icons.place_outlined, c.billingAddress),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 40, color: AppColors.text3),
            const SizedBox(height: AppSpacing.md12),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.text2)),
          ]),
        ),
      );
}
