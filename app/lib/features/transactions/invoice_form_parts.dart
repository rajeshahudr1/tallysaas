import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';

/// Shared building blocks for the invoice forms (sales + purchase), so the two
/// screens differ only in their header (customer vs supplier) and endpoint.
///
///   • [LineRow]              — mutable per-line state (product FK + controllers)
///   • [computeInvoiceTotals] — the client-side totals preview (server is the
///                              authoritative source on save)
///   • [LineItemCard]         — the editable line card
///   • [InvoiceDateField]     — a read-only, tappable date field

/// Mutable per-line state: the product FK + a controller per editable number.
class LineRow {
  int? productId;
  final desc = TextEditingController();
  final qty = TextEditingController();
  final rate = TextEditingController();
  final disc = TextEditingController(text: '0');
  final gst = TextEditingController(text: '0');

  void dispose() {
    desc.dispose();
    qty.dispose();
    rate.dispose();
    disc.dispose();
    gst.dispose();
  }

  /// The computed line amount (taxable + GST), mirroring the server math.
  double get amount {
    final q = double.tryParse(qty.text.trim()) ?? 0;
    final r = double.tryParse(rate.text.trim()) ?? 0;
    final d = double.tryParse(disc.text.trim()) ?? 0;
    final g = double.tryParse(gst.text.trim()) ?? 0;
    final gross = q * r;
    final taxable = gross - (gross * d / 100);
    return taxable + (taxable * g / 100);
  }

  /// Build the API line body, or null when the line is blank/invalid (qty must
  /// be > 0 and rate must parse).
  Map<String, dynamic>? toBody() {
    final q = double.tryParse(qty.text.trim()) ?? 0;
    final r = double.tryParse(rate.text.trim());
    if (q <= 0 || r == null) return null;
    return {
      if (productId != null) 'product_id': productId,
      if (desc.text.trim().isNotEmpty) 'description': desc.text.trim(),
      'quantity': q,
      'rate': r,
      'discount_pct': double.tryParse(disc.text.trim()) ?? 0,
      'gst_rate': double.tryParse(gst.text.trim()) ?? 0,
    };
  }
}

class InvoiceTotals {
  const InvoiceTotals({
    required this.subtotal,
    required this.discount,
    required this.tax,
    required this.total,
  });
  final double subtotal;
  final double discount;
  final double tax;
  final double total;
}

InvoiceTotals computeInvoiceTotals(List<LineRow> rows) {
  double subtotal = 0, discount = 0, taxable = 0, tax = 0;
  for (final r in rows) {
    final q = double.tryParse(r.qty.text.trim()) ?? 0;
    final rate = double.tryParse(r.rate.text.trim()) ?? 0;
    final disc = double.tryParse(r.disc.text.trim()) ?? 0;
    final gst = double.tryParse(r.gst.text.trim()) ?? 0;
    final gross = q * rate;
    final discAmt = gross * disc / 100;
    final lineTaxable = gross - discAmt;
    final gstAmt = lineTaxable * gst / 100;
    subtotal += gross;
    discount += discAmt;
    taxable += lineTaxable;
    tax += gstAmt;
  }
  final grand = taxable + tax;
  return InvoiceTotals(
    subtotal: subtotal,
    discount: discount,
    tax: tax,
    total: grand.roundToDouble(),
  );
}

class LineItemCard extends StatelessWidget {
  const LineItemCard({super.key, required this.row, required this.onChanged, this.onRemove});
  final LineRow row;
  final VoidCallback onChanged;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: AppCard(
        child: Column(
          children: [
            FkDropdown(
              label: 'Product', endpoint: '/products',
              value: row.productId,
              onChanged: (v) { row.productId = v; onChanged(); },
            ),
            const SizedBox(height: AppSpacing.sm8),
            AppTextField(
              controller: row.desc, hint: 'Description (optional)',
              onChanged: (_) => onChanged(),
            ),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(child: AppTextField(
                  controller: row.qty, hint: 'Qty',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (_) => onChanged(),
                )),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: AppTextField(
                  controller: row.rate, hint: 'Rate',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (_) => onChanged(),
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(child: AppTextField(
                  controller: row.disc, hint: 'Disc %',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (_) => onChanged(),
                )),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: AppTextField(
                  controller: row.gst, hint: 'GST %',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (_) => onChanged(),
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                if (onRemove != null)
                  TextButton.icon(
                    onPressed: onRemove,
                    icon: const Icon(Icons.delete_outline, size: 18, color: AppColors.danger),
                    label: const Text('Remove', style: TextStyle(color: AppColors.danger)),
                  )
                else
                  const SizedBox.shrink(),
                Text('Amount ${Fmt.inr(row.amount)}', style: theme.textTheme.titleSmall),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A read-only, tappable date display used for invoice / due dates.
class InvoiceDateField extends StatelessWidget {
  const InvoiceDateField({
    super.key,
    required this.label,
    required this.value,
    required this.onTap,
  });
  final String label;
  final DateTime? value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          child: InputDecorator(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.event_outlined, size: 18),
            ),
            child: Text(
              value == null ? 'Select' : DateFormat('dd/MM/yyyy').format(value!),
              style: value == null ? TextStyle(color: theme.hintColor) : null,
            ),
          ),
        ),
      ],
    );
  }
}
