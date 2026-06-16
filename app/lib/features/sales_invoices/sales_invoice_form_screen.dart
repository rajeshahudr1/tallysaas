import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/repositories/invoice_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart';

/// New Sales Invoice form. Header (customer*, location, sales person, dates,
/// notes) + a dynamic list of line items. A live totals preview mirrors the
/// server math, but the API computes the authoritative totals on
/// `POST /sales-invoices`. Pops `true` to refresh. Every FK is fetched live —
/// nothing is hardcoded.
class SalesInvoiceFormScreen extends ConsumerStatefulWidget {
  const SalesInvoiceFormScreen({super.key});

  @override
  ConsumerState<SalesInvoiceFormScreen> createState() => _SalesInvoiceFormScreenState();
}

class _SalesInvoiceFormScreenState extends ConsumerState<SalesInvoiceFormScreen> {
  int? _customerId;
  int? _locationId;
  int? _salesPersonId;
  DateTime _invoiceDate = _today();
  DateTime? _dueDate;
  final _notes = TextEditingController();

  final List<LineRow> _rows = [LineRow()];
  bool _busy = false;

  static DateTime _today() {
    final n = DateTime.now();
    return DateTime(n.year, n.month, n.day);
  }

  @override
  void dispose() {
    _notes.dispose();
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  void _addRow() => setState(() => _rows.add(LineRow()));

  void _removeRow(LineRow row) {
    setState(() {
      _rows.remove(row);
      row.dispose();
      if (_rows.isEmpty) _rows.add(LineRow());
    });
  }

  Future<void> _pickDate({required bool due}) async {
    final base = due ? (_dueDate ?? _invoiceDate) : _invoiceDate;
    final picked = await showDatePicker(
      context: context,
      initialDate: base,
      firstDate: DateTime(base.year - 5),
      lastDate: DateTime(base.year + 5),
    );
    if (picked != null) {
      setState(() => due ? _dueDate = picked : _invoiceDate = picked);
    }
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_customerId == null) {
      _showError('Please select a customer.');
      return;
    }
    final lines = _rows.map((r) => r.toBody()).whereType<Map<String, dynamic>>().toList();
    if (lines.isEmpty) {
      _showError('Add at least one line item (quantity and rate).');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(invoiceRepositoryProvider).createSales({
        'customer_id': _customerId,
        if (_locationId != null) 'location_id': _locationId,
        if (_salesPersonId != null) 'sales_person_id': _salesPersonId,
        'invoice_date': DateFormat('yyyy-MM-dd').format(_invoiceDate),
        if (_dueDate != null) 'due_date': DateFormat('yyyy-MM-dd').format(_dueDate!),
        if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
        'items': lines,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Sales invoice created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create invoice: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = computeInvoiceTotals(_rows);
    return Scaffold(
      appBar: AppBar(title: const Text('New Sales Invoice')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          FkDropdown(
            label: 'Customer *', endpoint: '/customers',
            value: _customerId, onChanged: (v) => setState(() => _customerId = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          Row(
            children: [
              Expanded(child: InvoiceDateField(
                label: 'Invoice Date *', value: _invoiceDate,
                onTap: () => _pickDate(due: false),
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: InvoiceDateField(
                label: 'Due Date', value: _dueDate,
                onTap: () => _pickDate(due: true),
              )),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          FkDropdown(
            label: 'Location', endpoint: '/locations',
            value: _locationId, onChanged: (v) => setState(() => _locationId = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          FkDropdown(
            label: 'Sales Person', endpoint: '/sales-persons',
            value: _salesPersonId, onChanged: (v) => setState(() => _salesPersonId = v),
          ),
          const SizedBox(height: AppSpacing.lg16),

          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Items', style: theme.textTheme.titleMedium),
              TextButton.icon(
                onPressed: _addRow,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add item'),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          for (final row in _rows)
            LineItemCard(
              row: row,
              onChanged: () => setState(() {}),
              onRemove: _rows.length > 1 ? () => _removeRow(row) : null,
            ),

          const SizedBox(height: AppSpacing.md12),
          AppCard(
            child: Column(
              children: [
                _totalRow('Subtotal', t.subtotal, theme),
                if (t.discount > 0) _totalRow('Discount', -t.discount, theme),
                _totalRow('Tax (GST)', t.tax, theme),
                const Divider(height: AppSpacing.lg16),
                _totalRow('Total', t.total, theme, bold: true),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text(
            'Totals are recomputed by the server on save.',
            style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
          ),
          const SizedBox(height: AppSpacing.md12),

          AppTextField(controller: _notes, label: 'Notes', maxLines: 2),
          const SizedBox(height: AppSpacing.xl24),

          AppButton(label: 'Save Invoice', loading: _busy, onPressed: _save),
        ],
      ),
    );
  }

  Widget _totalRow(String label, num value, ThemeData theme, {bool bold = false}) {
    final style = bold
        ? theme.textTheme.titleMedium
        : theme.textTheme.bodyMedium?.copyWith(color: AppColors.text2);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: style),
          Text(Fmt.inr(value), style: style),
        ],
      ),
    );
  }
}
