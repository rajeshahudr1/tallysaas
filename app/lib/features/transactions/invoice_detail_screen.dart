import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../data/repositories/invoice_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/pdf_action_button.dart';
import '../../shared/widgets/status_pill.dart';

/// Invoice detail (View) — shared by Sales + Purchase via [basePath]/[module]/
/// [title]. Uses the shared [DetailScaffold]: NO Edit (invoices aren't edited,
/// like the web — cancel + re-create), Delete gated by `<module>.delete`.
class InvoiceDetailScreen extends ConsumerWidget {
  const InvoiceDetailScreen({
    super.key,
    required this.basePath,
    required this.module,
    required this.title,
    required this.invoiceId,
  });

  final String basePath; // '/sales-invoices' | '/purchase-invoices'
  final String module;   // 'sales-invoices' | 'purchase-invoices'
  final String title;    // 'Sales Invoice' | 'Purchase Invoice'
  final int invoiceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(invoiceRepositoryProvider);
    return DetailScaffold<Invoice>(
      title: title,
      module: module,
      load: () => repo.get(basePath, invoiceId),
      onDelete: () => repo.delete(basePath, invoiceId),
      extraActions: [
        PdfActionButton(path: '$basePath/$invoiceId/pdf', name: '$title ${invoiceId.toString()}'),
      ],
      // editRoute: null — invoices have no edit.
      deleteTitle: 'Delete invoice?',
      deleteMessage: 'This invoice will be removed. You can re-sync it from Tally later.',
      deletedMessage: 'Invoice deleted.',
      bodyBuilder: (context, inv) => [
        DetailHeader(
          inv.invoiceNo,
          trailing: inv.status != null ? StatusPill(invoiceStatusLabel(inv.status)) : null,
        ),
        const DetailSection('Details', first: true),
        DetailRow('Party', inv.party),
        DetailRow('Date', inv.invoiceDate == null ? null : Fmt.date(inv.invoiceDate)),
        DetailRow('Due Date', inv.dueDate == null ? null : Fmt.date(inv.dueDate)),
        DetailRow('Location', inv.location),
        if (inv.items.isNotEmpty) ...[
          const DetailSection('Items'),
          for (final it in inv.items) _ItemRow(it),
        ],
        const DetailSection('Totals'),
        DetailRow('Taxable', inv.taxable == null ? null : Fmt.inr(inv.taxable)),
        DetailRow('Discount', inv.discount == null ? null : Fmt.inr(inv.discount)),
        DetailRow('Tax', inv.taxAmount == null ? null : Fmt.inr(inv.taxAmount)),
        DetailRow('Round Off', inv.roundOff == null ? null : Fmt.inr(inv.roundOff)),
        DetailRow('Total', inv.total == null ? null : Fmt.inr(inv.total)),
        DetailRow('Notes', inv.notes),
      ],
    );
  }
}

/// One invoice line rendered compactly: description on the left, qty × rate and
/// the line amount on the right.
class _ItemRow extends StatelessWidget {
  const _ItemRow(this.it);
  final InvoiceItem it;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final qtyRate = [
      if (it.quantity != null) '${Fmt.num0(it.quantity)} ${it.unit ?? ''}'.trim(),
      if (it.rate != null) '@ ${Fmt.inr(it.rate)}',
    ].join('  ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(it.description ?? 'Item', style: theme.textTheme.bodyMedium),
                if (qtyRate.isNotEmpty)
                  Text(qtyRate, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
              ],
            ),
          ),
          if (it.amount != null)
            Text(Fmt.inr(it.amount), style: theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}
