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

/// New Physical Stock sheet — record the quantity actually counted for each
/// item. A count of 0 is meaningful (the shelf was empty), so a blank quantity
/// is what marks a line unfilled, not a zero.
class PhysicalStockFormScreen extends ConsumerStatefulWidget {
  const PhysicalStockFormScreen({super.key});

  @override
  ConsumerState<PhysicalStockFormScreen> createState() =>
      _PhysicalStockFormScreenState();
}

class _CountLine {
  int? productId;
  String? productName;
  final qty = TextEditingController();
  final godown = TextEditingController();

  void dispose() {
    qty.dispose();
    godown.dispose();
  }

  /// The API line body, or null when the line is unfilled. `counted_qty` may be
  /// 0 — only a missing product or a blank/unparseable quantity skips the line.
  Map<String, dynamic>? toBody() {
    final text = qty.text.trim();
    if (productId == null || text.isEmpty) return null;
    final q = double.tryParse(text);
    if (q == null) return null;
    return {
      'product_id': productId,
      'counted_qty': q,
      if (godown.text.trim().isNotEmpty) 'godown': godown.text.trim(),
    };
  }
}

class _PhysicalStockFormScreenState extends ConsumerState<PhysicalStockFormScreen> {
  final _voucherNo = TextEditingController();
  final _notes = TextEditingController();
  DateTime _date = DateTime.now();
  bool _busy = false;

  final List<_CountLine> _lines = [_CountLine()];

  @override
  void dispose() {
    _voucherNo.dispose();
    _notes.dispose();
    for (final l in _lines) {
      l.dispose();
    }
    super.dispose();
  }

  void _addLine() => setState(() => _lines.add(_CountLine()));

  void _removeLine(_CountLine l) {
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
      _snack('Add at least one item with a counted quantity.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(physicalStockRepositoryProvider).create({
        if (_voucherNo.text.trim().isNotEmpty) 'voucher_no': _voucherNo.text.trim(),
        'count_date': DateFormat('yyyy-MM-dd').format(_date),
        if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
        'items': items,
      });
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save this stock count.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('New Physical Stock')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          InvoiceDateField(label: 'Count Date *', value: _date, onTap: _pickDate),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _voucherNo,
            label: 'Voucher No',
            hint: 'Auto-generated on save',
          ),
          const SizedBox(height: AppSpacing.lg16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Counted items', style: theme.textTheme.titleMedium),
              TextButton.icon(
                onPressed: _addLine,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add item'),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          for (final l in _lines)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
              child: AppCard(
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: SearchableFkDropdown(
                            label: 'Product *',
                            endpoint: '/products',
                            value: l.productId,
                            onChanged: (v) => setState(() => l.productId = v),
                            onItem: (o) => setState(() => l.productName = o?.name),
                          ),
                        ),
                        if (_lines.length > 1)
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
                            label: 'Counted Qty *',
                            keyboardType:
                                const TextInputType.numberWithOptions(decimal: true),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.sm8),
                        Expanded(
                          child: AppTextField(controller: l.godown, label: 'Godown'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: AppSpacing.sm8),
          AppTextField(controller: _notes, label: 'Notes', maxLines: 2),
          const SizedBox(height: AppSpacing.lg16),
          AppButton(label: 'Save Stock Count', loading: _busy, onPressed: _save),
        ],
      ),
    );
  }
}
