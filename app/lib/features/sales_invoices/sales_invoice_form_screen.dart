import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/gps/gps_tracker.dart';
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
  const SalesInvoiceFormScreen({super.key, this.editId});

  /// When set, the form loads that invoice and EDITS it (draft/pending/rejected);
  /// saving re-submits it for approval. Null → a new invoice.
  final int? editId;

  @override
  ConsumerState<SalesInvoiceFormScreen> createState() => _SalesInvoiceFormScreenState();
}

class _SalesInvoiceFormScreenState extends ConsumerState<SalesInvoiceFormScreen> {
  int? _customerId;
  int? _locationId;
  int? _salesPersonId;
  String? _locationName;   // display for the salesman's read-only Location
  DateTime _invoiceDate = _today();
  DateTime? _dueDate;
  final _notes = TextEditingController();

  final List<LineRow> _rows = [LineRow()];
  bool _busy = false;
  bool get _isEdit => widget.editId != null;
  bool _loadingEdit = false;
  String? _loadError;

  static DateTime _today() {
    final n = DateTime.now();
    return DateTime(n.year, n.month, n.day);
  }

  static DateTime? _parseYmd(String? s) {
    if (s == null || s.isEmpty) return null;
    return DateTime.tryParse(s.length > 10 ? s.substring(0, 10) : s);
  }

  @override
  void initState() {
    super.initState();
    // A salesman login IS the sales person — their role can't list sales_persons
    // (403), so pre-set their own id (the field renders read-only in build()).
    final session = ref.read(sessionProvider);
    if (session is SessionSignedIn && session.user.isSalesman) {
      _salesPersonId = session.user.salesPersonId;
    }
    if (_isEdit) {
      _loadForEdit();
    } else {
      // SFA — capture location on opening the CREATE page (gated by the
      // super-admin GPS config's track_on_create + window). Fire-and-forget.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(gpsTrackerProvider).captureOnCreate();
      });
    }
  }

  /// Fetch the invoice being edited and seed the header + line items.
  Future<void> _loadForEdit() async {
    setState(() => _loadingEdit = true);
    try {
      final inv = await ref.read(invoiceRepositoryProvider).getSales(widget.editId!);
      _customerId = inv.customerId;
      _locationId = inv.locationId;
      _locationName = inv.location;
      if (inv.salesPersonId != null) _salesPersonId = inv.salesPersonId;
      _invoiceDate = _parseYmd(inv.invoiceDate) ?? _today();
      _dueDate = _parseYmd(inv.dueDate);
      _notes.text = inv.notes ?? '';
      for (final r in _rows) {
        r.dispose();
      }
      _rows.clear();
      for (final it in inv.items) {
        final row = LineRow()
          ..productId = it.productId
          ..desc.text = it.description ?? ''
          ..qty.text = (it.quantity ?? 1).toString()
          ..rate.text = (it.rate ?? 0).toString()
          ..disc.text = (it.discountPct ?? 0).toString()
          ..gst.text = (it.gstRate ?? 0).toString();
        _rows.add(row);
      }
      if (_rows.isEmpty) _rows.add(LineRow());
    } on ApiException catch (e) {
      _loadError = e.message;
    } catch (e) {
      _loadError = 'Could not load the invoice: $e';
    } finally {
      if (mounted) setState(() => _loadingEdit = false);
    }
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

  Future<void> _save({bool asDraft = false}) async {
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

    // SFA — a linked salesman's invoice goes for approval (or saves as a draft);
    // an admin's saves straight through. Drives the confirmation message.
    final session = ref.read(sessionProvider);
    final isSalesman = session is SessionSignedIn && session.user.isSalesman;

    setState(() => _busy = true);
    try {
      final body = <String, dynamic>{
        'customer_id': _customerId,
        if (_locationId != null) 'location_id': _locationId,
        if (_salesPersonId != null) 'sales_person_id': _salesPersonId,
        'invoice_date': DateFormat('yyyy-MM-dd').format(_invoiceDate),
        if (_dueDate != null) 'due_date': DateFormat('yyyy-MM-dd').format(_dueDate!),
        if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
        // EDIT: send explicit false so the api RE-submits (draft/rejected →
        // pending); CREATE: only send when saving a draft.
        if (_isEdit) 'save_as_draft': asDraft else if (asDraft) 'save_as_draft': true,
        'items': lines,
      };
      final repo = ref.read(invoiceRepositoryProvider);
      if (_isEdit) {
        await repo.updateSales(widget.editId!, body);
      } else {
        await repo.createSales(body);
      }
      if (!mounted) return;
      final msg = asDraft
          ? 'Draft saved.'
          : _isEdit
              ? 'Invoice updated & re-submitted for approval.'
              : isSalesman
                  ? 'Invoice submitted for approval.'
                  : 'Sales invoice created.';
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(msg)));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save invoice: $e');
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
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final isSalesman = user?.isSalesman ?? false;
    final title = _isEdit ? 'Edit Invoice' : 'New Sales Invoice';
    if (_isEdit && _loadingEdit) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    if (_isEdit && _loadError != null) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.xl24),
            child: Text(_loadError!, textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.danger)),
          ),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          // Searchable customer picker; on select we AUTO-fill the Location from
          // that customer's own location (mirrors the web). Assignment-scoped by
          // the API, so a salesman sees only their assigned customers.
          SearchableFkDropdown(
            label: 'Customer *', endpoint: '/customers',
            value: _customerId,
            onChanged: (v) => setState(() => _customerId = v),
            onItem: (o) => setState(() {
              if (o?.locationId != null) {
                _locationId = o!.locationId;
                _locationName = o.locationName;
              }
            }),
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
          // Location — a salesman can't list locations (403); it auto-fills from
          // the picked customer and shows read-only. An admin picks it normally.
          if (isSalesman)
            _ReadOnlyField(
              label: 'Location',
              value: _locationName ?? (_locationId != null ? 'Selected' : null),
              hint: 'Auto from customer',
            )
          else
            FkDropdown(
              label: 'Location', endpoint: '/locations',
              value: _locationId, onChanged: (v) => setState(() => _locationId = v),
            ),
          const SizedBox(height: AppSpacing.md12),
          // Sales Person — login IS the sales person for a salesman: read-only self.
          if (isSalesman)
            _ReadOnlyField(label: 'Sales Person', value: user?.name)
          else
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

          Builder(builder: (_) {
            final session = ref.watch(sessionProvider);
            final isSalesman = session is SessionSignedIn && session.user.isSalesman;
            if (_isEdit) {
              // Editing an un-approved invoice → save re-submits it for approval.
              return Column(children: [
                AppButton(label: 'Update & Re-submit', loading: _busy, onPressed: () => _save()),
                const SizedBox(height: AppSpacing.sm8),
                OutlinedButton.icon(
                  onPressed: _busy ? null : () => _save(asDraft: true),
                  icon: const Icon(Icons.save_outlined, size: 18),
                  label: const Text('Save as Draft'),
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                ),
              ]);
            }
            if (!isSalesman) {
              return AppButton(label: 'Save Invoice', loading: _busy, onPressed: () => _save());
            }
            // Salesman — submit for approval, or keep an editable draft.
            return Column(children: [
              AppButton(label: 'Submit for Approval', loading: _busy, onPressed: () => _save()),
              const SizedBox(height: AppSpacing.sm8),
              OutlinedButton.icon(
                onPressed: _busy ? null : () => _save(asDraft: true),
                icon: const Icon(Icons.save_outlined, size: 18),
                label: const Text('Save as Draft'),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              ),
            ]);
          }),
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

/// A labelled READ-ONLY field — a non-editable value that matches the FkDropdown
/// look. Used for a salesman's auto-filled Location + their own Sales Person.
class _ReadOnlyField extends StatelessWidget {
  const _ReadOnlyField({required this.label, required this.value, this.hint});
  final String label;
  final String? value;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final shown = (value != null && value!.trim().isNotEmpty);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        InputDecorator(
          decoration: const InputDecoration(
            filled: true,
            fillColor: AppColors.scaffoldBg,
            suffixIcon: Icon(Icons.lock_outline, size: 18),
          ),
          child: Text(
            shown ? value! : (hint ?? '—'),
            style: shown ? null : TextStyle(color: theme.hintColor),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}
