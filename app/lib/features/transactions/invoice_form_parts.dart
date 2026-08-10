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
  /// Captured from the picked product option — drives the qty-vs-stock guard
  /// (mirrors the server rule) and the "In stock: N" helper text.
  double? stock;
  String? productName;

  /// Captured from the picked product and sent with the line — the API accepts
  /// both, and the web sends them, so a saved voucher keeps the HSN/unit it was
  /// billed under even if the product master changes later.
  String? hsn;
  String? unit;

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
      if (hsn != null && hsn!.isNotEmpty) 'hsn': hsn,
      if (unit != null && unit!.isNotEmpty) 'unit': unit,
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
  const LineItemCard({
    super.key,
    required this.row,
    required this.onChanged,
    this.onRemove,
    this.lockPricing = false,
    this.rateFor,
  });
  final LineRow row;
  final VoidCallback onChanged;
  final VoidCallback? onRemove;

  /// The active price level's rate for an item at a quantity, or null when the
  /// level says nothing about it (or no level is chosen). Supplied by the form,
  /// which owns the level and its loaded rate card.
  final double? Function(String itemName, double qty)? rateFor;

  /// Customer-portal login: Rate + Disc % are LOCKED (the price list decides;
  /// the server ignores client values and recomputes — this keeps the on-screen
  /// preview honest).
  final bool lockPricing;

  /// The active level's rate for THIS line, at its current quantity.
  double? _levelRate() {
    final name = row.productName;
    if (rateFor == null || name == null || name.isEmpty) return null;
    return rateFor!(name, double.tryParse(row.qty.text.trim()) ?? 0);
  }

  /// A rate as text, without a pointless trailing ".0".
  static String _num(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: AppCard(
        child: Column(
          children: [
            SearchableFkDropdown(
              label: 'Product', endpoint: '/products',
              value: row.productId,
              onChanged: (v) { row.productId = v; onChanged(); },
              // Capture stock + auto-fill rate/GST from the picked product
              // (the rate is already price-list-adjusted for a portal login).
              onItem: (o) {
                row.stock = o?.stock;
                row.productName = o?.name;
                row.hsn = o?.hsn;
                row.unit = o?.unit;
                // Rate: the chosen PRICE LEVEL wins where it covers this item —
                // that is the whole point of picking a level — otherwise the
                // item's own standard price.
                final levelRate = _levelRate();
                if (levelRate != null) {
                  row.rate.text = _num(levelRate);
                } else if (o?.rate != null) {
                  row.rate.text = o!.rate!.toString();
                }
                if (o?.gstRate != null) row.gst.text = o!.gstRate!.toString();
                // Stock on hand is a HINT, not a cap. This card is shared by
                // every voucher form, and a quotation or an order is a promise
                // about goods you may not hold yet — Tally itself allows a
                // negative balance. Silently rewriting the typed quantity down
                // to the stock (usually 0 on a freshly synced item) is how the
                // Qty box appeared to be broken. Only the sales-invoice form
                // enforces a limit, and it says so instead of retyping for you.
                onChanged();
              },
            ),
            if (row.stock != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('In stock: ${row.stock == row.stock!.roundToDouble() ? row.stock!.toInt() : row.stock}',
                      style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                ),
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
                  // No live clamp — see the note on the product picker above.
                  // Typing into a box that rewrites what you typed is worse
                  // than an error message you can read.
                  onChanged: (_) {
                    // A price level can band its rate by quantity, so crossing
                    // a band boundary has to re-rate the line — otherwise the
                    // qty says one band and the rate still shows the other.
                    final r = _levelRate();
                    if (r != null) row.rate.text = _num(r);
                    onChanged();
                  },
                )),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: AppTextField(
                  controller: row.rate, hint: 'Rate',
                  readOnly: lockPricing,
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
                  readOnly: lockPricing,
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

/// Stock guard (every role — the server enforces the same rule): per product,
/// the SUMMED quantity across lines may not exceed the stock captured when the
/// product was picked. Returns a user-facing error message, or null when OK.
String? validateLineStock(List<LineRow> rows) {
  final need = <int, double>{};
  final stockOf = <int, double>{};
  final nameOf = <int, String>{};
  for (final r in rows) {
    final pid = r.productId;
    if (pid == null) continue;
    final q = double.tryParse(r.qty.text.trim()) ?? 0;
    if (q <= 0) continue;
    need[pid] = (need[pid] ?? 0) + q;
    if (r.stock != null) stockOf[pid] = r.stock!;
    if (r.productName != null) nameOf[pid] = r.productName!;
  }
  for (final e in need.entries) {
    final stock = stockOf[e.key];
    if (stock == null) continue;   // stock unknown → let the server decide
    if (e.value > stock) {
      final nm = nameOf[e.key] ?? 'this product';
      final st = stock == stock.roundToDouble() ? stock.toInt().toString() : stock.toString();
      return 'Not enough stock for "$nm" — only $st available.';
    }
  }
  return null;
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
