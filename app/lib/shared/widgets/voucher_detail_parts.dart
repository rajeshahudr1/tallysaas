import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/voucher_item.dart';
import 'app_card.dart';
import 'status_pill.dart';

/// Shared building blocks for an ITEM-STYLE voucher's detail screen —
/// quotations, sales/purchase orders, delivery + receipt notes. They all show
/// the same three things, so the screens differ only in their field rows.
///
///   • [VoucherSummaryHeader] — gradient header: party, amount, status, a line
///   • [VoucherItemCard]      — one line item with every column the web table has
///   • [VoucherTotalsCard]    — subtotal → discount → taxable → GST → grand total

/// The gradient summary block at the top of a voucher detail screen.
class VoucherSummaryHeader extends StatelessWidget {
  const VoucherSummaryHeader({
    super.key,
    required this.title,
    required this.amount,
    required this.statusLabel,
    this.subtitle,
  });

  final String title;
  final num amount;
  final String statusLabel;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.lg16),
      decoration: BoxDecoration(
        gradient: AppGradients.header,
        borderRadius: BorderRadius.circular(AppRadius.lg16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(title, style: theme.textTheme.titleLarge)),
              StatusPill(statusLabel),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text(Fmt.inr(amount), style: theme.textTheme.headlineSmall),
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(subtitle!, style: theme.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// One line item: description + amount, then qty × rate (and discount), then
/// the secondary columns (HSN, GST, godown, tax-inclusive) the web shows as
/// extra table columns.
class VoucherItemCard extends StatelessWidget {
  const VoucherItemCard(this.item, {super.key});
  final VoucherItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(item.description ?? 'Item',
                    style: theme.textTheme.titleMedium),
              ),
              Text(Fmt.inr(item.amount ?? 0), style: theme.textTheme.titleSmall),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${item.quantity ?? 0} ${item.unit ?? ''} × ${Fmt.inr(item.rate ?? 0)}'
            '${(item.discountPct ?? 0) > 0 ? '  •  ${item.discountPct}% off' : ''}',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 2),
          Text(
            [
              if (item.hsn != null) 'HSN ${item.hsn}',
              'GST ${item.gstRate ?? 0}%',
              if ((item.gstAmount ?? 0) > 0) Fmt.inr(item.gstAmount ?? 0),
              if (item.godown != null) item.godown!,
              if (item.taxInclusive) 'Tax incl.',
            ].join('  •  '),
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

/// The tax breakup card. CGST/SGST and IGST are mutually exclusive on a
/// voucher, so only the applicable pair is shown.
class VoucherTotalsCard extends StatelessWidget {
  const VoucherTotalsCard({
    super.key,
    required this.subtotal,
    required this.discount,
    required this.taxable,
    required this.cgst,
    required this.sgst,
    required this.igst,
    required this.roundOff,
    required this.total,
  });

  final num? subtotal;
  final num? discount;
  final num? taxable;
  final num? cgst;
  final num? sgst;
  final num? igst;
  final num? roundOff;
  final num? total;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        children: [
          _row(context, 'Sub Total', subtotal),
          _row(context, 'Discount', discount),
          _row(context, 'Taxable', taxable),
          if ((igst ?? 0) > 0)
            _row(context, 'IGST', igst)
          else ...[
            _row(context, 'CGST', cgst),
            _row(context, 'SGST', sgst),
          ],
          _row(context, 'Round Off', roundOff),
          const Divider(),
          _row(context, 'Grand Total', total, strong: true),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, String label, num? value, {bool strong = false}) {
    final theme = Theme.of(context);
    final style = strong
        ? theme.textTheme.titleMedium?.copyWith(color: AppColors.primary)
        : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: strong ? style : theme.textTheme.bodySmall),
          Text(Fmt.inr(value ?? 0), style: style),
        ],
      ),
    );
  }
}

/// 'yyyy-MM-dd' → '01 Aug 2026'; returns the raw string when unparseable and
/// null when absent, so a [DetailRow] hides itself.
String? voucherDate(String? iso) {
  if (iso == null) return null;
  final d = DateTime.tryParse(iso);
  return d == null ? iso : Fmt.date(d);
}
