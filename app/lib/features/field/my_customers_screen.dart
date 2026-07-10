import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/launchers.dart';
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
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.md12),
        onTap: () => _openDetail(context, c),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md12),
          child: Row(
            children: [
              Expanded(
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
              const Icon(Icons.chevron_right, color: AppColors.text3),
            ],
          ),
        ),
      ),
    );
  }

  void _openDetail(BuildContext context, Customer c) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _CustomerDetailSheet(c),
    );
  }
}

/// Tap a customer → full details with quick Call / WhatsApp actions.
class _CustomerDetailSheet extends StatelessWidget {
  const _CustomerDetailSheet(this.c);
  final Customer c;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Widget row(IconData ic, String label, String? value) {
      if (value == null || value.trim().isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.md12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(ic, size: 18, color: AppColors.text3),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
              const SizedBox(height: 1),
              Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            ]),
          ),
        ]),
      );
    }

    final hasMobile = (c.mobile ?? '').trim().isNotEmpty;
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16,
          AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(c.name, style: theme.textTheme.titleMedium)),
            IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
          ]),
          const Divider(height: 20),
          row(Icons.phone_outlined, 'Mobile', c.mobile),
          row(Icons.email_outlined, 'Email', c.email),
          row(Icons.location_on_outlined, 'Location', c.location),
          row(Icons.receipt_long_outlined, 'GSTIN', c.gstNumber),
          row(Icons.place_outlined, 'Billing address', c.billingAddress),
          if (hasMobile) ...[
            const SizedBox(height: AppSpacing.sm8),
            Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => Launch.call(c.mobile),
                  icon: const Icon(Icons.call, size: 16),
                  label: const Text('Call'),
                  style: OutlinedButton.styleFrom(foregroundColor: AppColors.primary),
                ),
              ),
              const SizedBox(width: AppSpacing.sm8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => Launch.whatsapp(c.mobile),
                  icon: const Icon(Icons.chat_bubble_outline, size: 16),
                  label: const Text('WhatsApp'),
                  style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF16A34A)),
                ),
              ),
            ]),
          ],
          const SizedBox(height: AppSpacing.md12),
        ]),
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
