import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/constants.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/payment_request.dart';
import '../../data/repositories/collect_payment_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import 'collect_payments_controller.dart';

/// New payment request — pick an OUTSTANDING invoice and the API raises a
/// request for exactly what that bill still owes. There is no amount field:
/// the server reads it from the invoice and ignores anything a client sends.
class CollectPaymentNewScreen extends ConsumerStatefulWidget {
  const CollectPaymentNewScreen({super.key});

  @override
  ConsumerState<CollectPaymentNewScreen> createState() =>
      _CollectPaymentNewScreenState();
}

class _CollectPaymentNewScreenState extends ConsumerState<CollectPaymentNewScreen> {
  final _note = TextEditingController();
  int? _busyFor;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _create(OutstandingInvoice inv) async {
    if (_busyFor != null) return;
    setState(() => _busyFor = inv.id);
    try {
      final created = await ref
          .read(collectPaymentRepositoryProvider)
          .create(inv.id, note: _note.text);
      if (!mounted) return;
      await _showLink(created);
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not create the payment request.');
    } finally {
      if (mounted) setState(() => _busyFor = null);
    }
  }

  /// Shows the fresh link so it can be sent right away — the whole point of
  /// creating a request on a phone.
  Future<void> _showLink(PaymentRequest r) async {
    final link = AppConfig.payLink(r.token);
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Payment request created'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${r.customer ?? 'Customer'} • ${Fmt.inr(r.amount ?? 0)}'),
            const SizedBox(height: AppSpacing.md12),
            SelectableText(
              link ?? r.token ?? '—',
              style: Theme.of(ctx).textTheme.bodySmall,
            ),
            if (link == null) ...[
              const SizedBox(height: AppSpacing.sm8),
              Text(
                'This build has no web address configured, so only the token is '
                'shown.',
                style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                      color: AppColors.text3,
                    ),
              ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: link ?? r.token ?? ''));
              if (ctx.mounted) Navigator.pop(ctx);
              _snack('Copied.');
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
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(outstandingInvoicesProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('New Payment Request')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading outstanding bills…'),
        error: (e, _) => ErrorState(
          'Could not load outstanding invoices.',
          onRetry: () async => ref.invalidate(outstandingInvoicesProvider),
        ),
        data: (invoices) {
          if (invoices.isEmpty) {
            return const EmptyState(
              'Nothing outstanding — every invoice is settled.',
              icon: Icons.verified_outlined,
            );
          }
          return ListView(
            padding: const EdgeInsets.all(AppSpacing.md12),
            children: [
              AppTextField(
                controller: _note,
                label: 'Note (optional)',
                hint: 'Shown to the customer on the payment page',
              ),
              const SizedBox(height: AppSpacing.md12),
              Text('Outstanding invoices', style: theme.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.sm8),
              for (final inv in invoices) ...[
                AppCard(
                  onTap: _busyFor == null ? () => _create(inv) : null,
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(inv.customer ?? 'Customer',
                                style: theme.textTheme.titleMedium),
                            const SizedBox(height: 3),
                            Text(
                              [
                                if (inv.invoiceNo != null) inv.invoiceNo!,
                                if (inv.invoiceDate != null)
                                  Fmt.date(DateTime.parse(inv.invoiceDate!)),
                              ].join('  •  '),
                              style: theme.textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(Fmt.inr(inv.outstanding ?? 0),
                              style: theme.textTheme.titleSmall),
                          const SizedBox(height: 2),
                          Text('of ${Fmt.inr(inv.total ?? 0)}',
                              style: theme.textTheme.bodySmall),
                        ],
                      ),
                      if (_busyFor == inv.id) ...[
                        const SizedBox(width: AppSpacing.sm8),
                        const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2.2),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.sm8),
              ],
            ],
          );
        },
      ),
    );
  }
}
