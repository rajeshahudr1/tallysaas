import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/repositories/stock_voucher_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart' show InvoiceDateField;

/// New Stock Journal — moves quantity from SOURCE lines to DESTINATION lines.
/// No party, ledger, GST or totals: this voucher is quantities only, so it does
/// not reuse the invoice line-item card.
class StockJournalFormScreen extends ConsumerStatefulWidget {
  const StockJournalFormScreen({super.key});

  @override
  ConsumerState<StockJournalFormScreen> createState() =>
      _StockJournalFormScreenState();
}

/// Mutable per-line state for the stock-journal form.
class _StockLine {
  _StockLine({required this.direction});

  String direction; // 'source' | 'destination'
  int? productId;
  String? productName;
  final godown = TextEditingController();
  final qty = TextEditingController();
  final rate = TextEditingController();

  void dispose() {
    godown.dispose();
    qty.dispose();
    rate.dispose();
  }

  /// The API line body, or null when the line is incomplete (product required,
  /// quantity must be > 0 — the same rule the server enforces).
  Map<String, dynamic>? toBody() {
    final q = double.tryParse(qty.text.trim()) ?? 0;
    if (productId == null || q <= 0) return null;
    final r = double.tryParse(rate.text.trim());
    return {
      'product_id': productId,
      'direction': direction,
      if (godown.text.trim().isNotEmpty) 'godown': godown.text.trim(),
      'quantity': q,
      if (r != null) 'rate': r,
    };
  }
}

class _StockJournalFormScreenState extends ConsumerState<StockJournalFormScreen> {
  final _voucherNo = TextEditingController();
  final _narration = TextEditingController();
  DateTime _date = DateTime.now();
  bool _busy = false;

  final List<_StockLine> _lines = [
    _StockLine(direction: 'source'),
    _StockLine(direction: 'destination'),
  ];

  @override
  void dispose() {
    _voucherNo.dispose();
    _narration.dispose();
    for (final l in _lines) {
      l.dispose();
    }
    super.dispose();
  }

  void _addLine(String direction) =>
      setState(() => _lines.add(_StockLine(direction: direction)));

  void _removeLine(_StockLine l) {
    setState(() {
      _lines.remove(l);
      l.dispose();
    });
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked != null) setState(() => _date = picked);
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    if (_busy) return;
    final items = <Map<String, dynamic>>[];
    for (final l in _lines) {
      final body = l.toBody();
      if (body != null) items.add(body);
    }
    if (items.isEmpty) {
      _snack('Add at least one line with a product and a quantity.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(stockJournalRepositoryProvider).create({
        if (_voucherNo.text.trim().isNotEmpty) 'voucher_no': _voucherNo.text.trim(),
        'journal_date': DateFormat('yyyy-MM-dd').format(_date),
        if (_narration.text.trim().isNotEmpty) 'narration': _narration.text.trim(),
        'items': items,
      });
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save this stock journal.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sources = [for (final l in _lines) if (l.direction == 'source') l];
    final destinations = [for (final l in _lines) if (l.direction != 'source') l];

    return Scaffold(
      appBar: AppBar(title: const Text('New Stock Journal')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          InvoiceDateField(label: 'Date *', value: _date, onTap: _pickDate),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _voucherNo,
            label: 'Voucher No',
            hint: 'Auto-generated on save',
          ),
          const SizedBox(height: AppSpacing.lg16),

          _sectionHeader(theme, 'Source — stock out', () => _addLine('source')),
          for (final l in sources) _lineCard(l, out: true),

          const SizedBox(height: AppSpacing.md12),
          _sectionHeader(
              theme, 'Destination — stock in', () => _addLine('destination')),
          for (final l in destinations) _lineCard(l, out: false),

          const SizedBox(height: AppSpacing.md12),
          AppTextField(controller: _narration, label: 'Narration', maxLines: 2),
          const SizedBox(height: AppSpacing.lg16),
          AppButton(label: 'Save Stock Journal', loading: _busy, onPressed: _save),
        ],
      ),
    );
  }

  Widget _sectionHeader(ThemeData theme, String title, VoidCallback onAdd) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(title, style: theme.textTheme.titleMedium),
        TextButton.icon(
          onPressed: onAdd,
          icon: const Icon(Icons.add, size: 18),
          label: const Text('Add line'),
        ),
      ],
    );
  }

  Widget _lineCard(_StockLine l, {required bool out}) {
    final removable = _lines.where((x) => x.direction == l.direction).length > 1;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: AppCard(
        child: Column(
          children: [
            Row(
              children: [
                Icon(
                  out ? Icons.arrow_upward : Icons.arrow_downward,
                  size: 18,
                  color: out ? AppColors.danger : AppColors.success,
                ),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(
                  child: SearchableFkDropdown(
                    label: 'Product *',
                    endpoint: '/products',
                    value: l.productId,
                    onChanged: (v) => setState(() => l.productId = v),
                    onItem: (o) => setState(() => l.productName = o?.name),
                  ),
                ),
                if (removable)
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    tooltip: 'Remove line',
                    onPressed: () => _removeLine(l),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(
                  child: AppTextField(
                    controller: l.qty,
                    label: 'Quantity *',
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(
                  child: AppTextField(
                    controller: l.rate,
                    label: 'Rate',
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            AppTextField(controller: l.godown, label: 'Godown'),
          ],
        ),
      ),
    );
  }
}
