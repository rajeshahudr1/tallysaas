import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../data/repositories/invoice_repository.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — the salesman's OWN invoices in ONE screen, grouped by approval status.
/// Approved is view-only; Pending / Rejected / Draft can be edited & re-submitted
/// (Draft also has a one-click Submit). The api is own-scoped (created_by).
final _approvalListProvider = FutureProvider.autoDispose
    .family<List<Invoice>, String>((ref, status) async {
  final paged = await ref
      .read(invoiceRepositoryProvider)
      .listSales(perPage: 100, filters: {'approval': status});
  return paged.items;
});

const _tabs = <({String key, String label})>[
  (key: 'pending', label: 'Pending'),
  (key: 'rejected', label: 'Rejected'),
  (key: 'draft', label: 'Drafts'),
  (key: 'approved', label: 'Approved'),
];

class MyApprovalsScreen extends ConsumerWidget {
  const MyApprovalsScreen({super.key, this.initialStatus = 'pending'});
  final String initialStatus;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    var initial = _tabs.indexWhere((t) => t.key == initialStatus);
    if (initial < 0) initial = 0;
    return DefaultTabController(
      length: _tabs.length,
      initialIndex: initial,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('My Approvals'),
          bottom: TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [for (final t in _tabs) Tab(text: t.label)],
          ),
        ),
        body: TabBarView(
          children: [for (final t in _tabs) _StatusList(status: t.key)],
        ),
      ),
    );
  }
}

class _StatusList extends ConsumerWidget {
  const _StatusList({required this.status});
  final String status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_approvalListProvider(status));
    return async.when(
      loading: () => const LoadingState(message: 'Loading…'),
      error: (e, _) => ErrorState(
        e is ApiException ? e.message : 'Could not load invoices.',
        onRetry: () => ref.invalidate(_approvalListProvider(status)),
      ),
      data: (rows) {
        if (rows.isEmpty) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.xl24),
              child: Text('No $status invoices.',
                  style: const TextStyle(color: AppColors.text2)),
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: () async => ref.invalidate(_approvalListProvider(status)),
          child: ListView.separated(
            padding: const EdgeInsets.all(AppSpacing.md12),
            itemCount: rows.length,
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (_, i) => _InvoiceCard(
              inv: rows[i],
              onChanged: () {
                // Re-load every tab (a submit/edit moves the row between tabs).
                for (final t in _tabs) {
                  ref.invalidate(_approvalListProvider(t.key));
                }
              },
            ),
          ),
        );
      },
    );
  }
}

class _InvoiceCard extends ConsumerWidget {
  const _InvoiceCard({required this.inv, required this.onChanged});
  final Invoice inv;
  final VoidCallback onChanged;

  Color _statusColor() {
    switch (inv.approvalStatus) {
      case 'approved':
        return AppColors.success;
      case 'rejected':
        return AppColors.danger;
      default:
        return AppColors.warn;
    }
  }

  Future<void> _submit(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(invoiceRepositoryProvider).submitDraft(inv.id);
      onChanged();
      if (context.mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Submitted for approval.')));
      }
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final st = inv.approvalStatus ?? '';
    final canEdit = st != 'approved';
    final canQuickSubmit = st == 'draft';
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Expanded(
                child: Text(inv.invoiceNo.isEmpty ? '#${inv.id}' : inv.invoiceNo,
                    style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: _statusColor().withOpacity(0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(st.isEmpty ? '—' : st,
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _statusColor())),
              ),
            ]),
            const SizedBox(height: 4),
            Text('${inv.customer ?? '—'}  ·  ${inv.invoiceDate ?? ''}',
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text2)),
            const SizedBox(height: 2),
            Text(Fmt.inr(inv.total ?? 0), style: theme.textTheme.titleSmall),
            if (st == 'rejected' && (inv.rejectionReason ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('Reason: ${inv.rejectionReason}',
                    style: const TextStyle(fontSize: 12, color: AppColors.danger)),
              ),
            const SizedBox(height: AppSpacing.sm8),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              TextButton.icon(
                onPressed: () => context.push('/sales-invoices/${inv.id}'),
                icon: const Icon(Icons.visibility_outlined, size: 18),
                label: const Text('View'),
              ),
              if (canEdit)
                TextButton.icon(
                  onPressed: () async {
                    final r = await context.push<bool>('/sales-invoices/${inv.id}/edit');
                    if (r == true) onChanged();
                  },
                  icon: const Icon(Icons.edit_outlined, size: 18),
                  label: Text(st == 'rejected' ? 'Edit & Re-submit' : 'Edit'),
                ),
              if (canQuickSubmit)
                FilledButton.icon(
                  onPressed: () => _submit(context, ref),
                  icon: const Icon(Icons.send_outlined, size: 18),
                  label: const Text('Submit'),
                ),
            ]),
          ],
        ),
      ),
    );
  }
}
