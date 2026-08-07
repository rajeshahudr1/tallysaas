import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/constants.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/payment_request.dart';
import '../../data/repositories/collect_payment_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';
import 'collect_payments_controller.dart';

/// Collect Payments — UPI payment requests raised against outstanding invoices.
/// A request is only ever marked paid by a human here, which also records the
/// receipt; there is no gateway callback.
class CollectPaymentsScreen extends ConsumerStatefulWidget {
  const CollectPaymentsScreen({super.key});

  @override
  ConsumerState<CollectPaymentsScreen> createState() => _CollectPaymentsScreenState();
}

class _CollectPaymentsScreenState extends ConsumerState<CollectPaymentsScreen> {
  String _tab = 'all';

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Copies the customer-facing link, or the raw token when this build has no
  /// WEB_BASE configured — guessing a wrong host would be worse than useless.
  Future<void> _copyLink(PaymentRequest r) async {
    final link = AppConfig.payLink(r.token);
    if (link != null) {
      await Clipboard.setData(ClipboardData(text: link));
      _snack('Payment link copied.');
    } else if (r.token != null) {
      await Clipboard.setData(ClipboardData(text: r.token!));
      _snack('Token copied — this build has no web address configured.');
    }
  }

  Future<void> _markPaid(PaymentRequest r) async {
    final ok = await ConfirmDialog.show(
      context,
      title: 'Mark as paid?',
      message: 'A receipt for ${Fmt.inr(r.amount ?? 0)} will be recorded against '
          '${r.invoiceNo ?? 'this invoice'}.',
      confirmLabel: 'Mark paid',
    );
    if (ok != true) return;
    try {
      await ref.read(collectPaymentRepositoryProvider).markPaid(r.id);
      _snack('Marked as paid; the receipt was recorded.');
      ref.read(collectPaymentsControllerProvider.notifier).refresh();
    } on ApiException catch (e) {
      _snack(e.message);
    }
  }

  Future<void> _cancel(PaymentRequest r) async {
    final ok = await ConfirmDialog.show(
      context,
      title: 'Cancel request?',
      message: 'The link will stop working. Nothing is recorded in the books.',
      confirmLabel: 'Cancel request',
      danger: true,
    );
    if (ok != true) return;
    try {
      await ref.read(collectPaymentRepositoryProvider).cancel(r.id);
      _snack('Payment request cancelled.');
      ref.read(collectPaymentsControllerProvider.notifier).refresh();
    } on ApiException catch (e) {
      _snack(e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(collectPaymentsControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('collect-payments', 'create') ?? false;
    final canEdit = user?.can('collect-payments', 'edit') ?? false;
    final ctrl = ref.read(collectPaymentsControllerProvider.notifier);
    final settings = ref.watch(collectPaymentSettingsProvider);

    final items =
        state is CollectPaymentsReady ? state.items : const <PaymentRequest>[];

    return ModuleListScaffold<PaymentRequest>(
      title: 'Collect Payments',
      infoKey: 'collect-payments',
      emptyMessage: 'No payment requests yet.',
      emptyIcon: Icons.credit_card,
      items: items,
      loading: state is CollectPaymentsLoading,
      error: state is CollectPaymentsError ? state.message : null,
      hasMore: state is CollectPaymentsReady && state.hasMore,
      loadingMore: state is CollectPaymentsReady && state.loadingMore,
      quickFilters: const [
        QuickFilter('all', 'All'),
        QuickFilter('pending', 'Pending'),
        QuickFilter('paid', 'Paid'),
        QuickFilter('cancelled', 'Cancelled'),
      ],
      currentQuickFilter: _tab,
      onQuickFilter: (v) {
        if (_tab == v) return;
        setState(() => _tab = v);
        ctrl.setStatus(v);
      },
      // The API offers no text search on this list.
      onSearch: (_) {},
      onLoadMore: ctrl.loadMore,
      onRefresh: () async {
        ref.invalidate(collectPaymentSettingsProvider);
        await ctrl.refresh();
      },
      onFilter: canEdit ? () => context.push('/collect-payments/settings') : null,
      fab: !canCreate
          ? null
          // Explicit heroTag: the shell shows a FloatingActionButton too.
          : FloatingActionButton.extended(
              heroTag: 'collect-payment-new',
              onPressed: () async {
                final created = await context.push<bool>('/collect-payments/add');
                if (created == true) ctrl.refresh();
              },
              icon: const Icon(Icons.add),
              label: const Text('Request'),
            ),
      itemBuilder: (context, r) => _RequestCard(
        r,
        canEdit: canEdit,
        onCopy: () => _copyLink(r),
        onMarkPaid: () => _markPaid(r),
        onCancel: () => _cancel(r),
        // A banner-style hint when UPI isn't configured: the first card carries
        // it so the user finds out before sending a link that can't be paid.
        warning: (items.isNotEmpty && r.id == items.first.id)
            ? settings.maybeWhen(
                data: (s) => s.enabled && s.upiVpa.isNotEmpty
                    ? null
                    : 'UPI is not set up yet — open the settings (top right) so '
                        'customers can actually pay.',
                orElse: () => null,
              )
            : null,
      ),
    );
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard(
    this.r, {
    required this.canEdit,
    required this.onCopy,
    required this.onMarkPaid,
    required this.onCancel,
    this.warning,
  });

  final PaymentRequest r;
  final bool canEdit;
  final VoidCallback onCopy;
  final VoidCallback onMarkPaid;
  final VoidCallback onCancel;
  final String? warning;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (warning != null) ...[
          Container(
            padding: const EdgeInsets.all(AppSpacing.md12),
            decoration: BoxDecoration(
              color: AppColors.warn.withOpacity(0.10),
              borderRadius: BorderRadius.circular(AppRadius.md12),
            ),
            child: Row(
              children: [
                const Icon(Icons.info_outline, size: 18, color: AppColors.warn),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(
                  child: Text(warning!, style: theme.textTheme.bodySmall),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.sm8),
        ],
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(r.customer ?? 'Customer',
                            style: theme.textTheme.titleMedium),
                        const SizedBox(height: 3),
                        Text(r.invoiceNo ?? '—', style: theme.textTheme.bodySmall),
                      ],
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(Fmt.inr(r.amount ?? 0),
                          style: theme.textTheme.titleSmall),
                      const SizedBox(height: 6),
                      StatusPill(r.status ?? 'pending'),
                    ],
                  ),
                ],
              ),
              if (r.note != null) ...[
                const SizedBox(height: AppSpacing.sm8),
                Text(r.note!, style: theme.textTheme.bodySmall),
              ],
              if (r.isPending) ...[
                const Divider(height: AppSpacing.xl24),
                Row(
                  children: [
                    TextButton.icon(
                      onPressed: onCopy,
                      icon: const Icon(Icons.link, size: 18),
                      label: const Text('Copy link'),
                    ),
                    const Spacer(),
                    if (canEdit) ...[
                      TextButton(onPressed: onCancel, child: const Text('Cancel')),
                      const SizedBox(width: AppSpacing.sm8),
                      FilledButton(
                        onPressed: onMarkPaid,
                        child: const Text('Mark paid'),
                      ),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
