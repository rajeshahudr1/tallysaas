import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/voucher_item.dart';
import '../../data/repositories/sales_order_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart';

/// Create / edit a sales order. Sectioned mobile form — Party → Items → Totals —
/// reusing the invoice form's line-item parts so both vouchers behave the same.
///
/// The totals shown here are a PREVIEW: the server recomputes every money
/// column inside the write transaction and never trusts client totals.
class SalesOrderFormScreen extends ConsumerStatefulWidget {
  const SalesOrderFormScreen({super.key, this.orderId});

  /// Null → create; set → edit that sales order.
  final int? orderId;

  @override
  ConsumerState<SalesOrderFormScreen> createState() => _SalesOrderFormScreenState();
}

class _SalesOrderFormScreenState extends ConsumerState<SalesOrderFormScreen> {
  final _orderNo = TextEditingController();
  final _notes = TextEditingController();

  int? _customerId;
  int? _locationId;
  String? _locationName;
  int? _salesPersonId;
  String? _ledgerName;

  DateTime _orderDate = DateTime.now();
  DateTime? _dueOn;

  final List<LineRow> _rows = [];

  bool _busy = false;
  bool _loading = false;
  String? _loadError;

  bool get _isEdit => widget.orderId != null;

  @override
  void initState() {
    super.initState();
    if (_isEdit) {
      _load();
    } else {
      _rows.add(LineRow());
      final session = ref.read(sessionProvider);
      // Customer-portal login: the party is THEMSELVES (the API forces it too).
      if (session is SessionSignedIn && session.user.isCustomerUser) {
        _customerId = session.user.customerId;
      }
    }
  }

  @override
  void dispose() {
    _orderNo.dispose();
    _notes.dispose();
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final so = await ref.read(salesOrderRepositoryProvider).get(widget.orderId!);
      if (!mounted) return;
      setState(() {
        _customerId = so.customerId;
        _locationId = so.locationId;
        _locationName = so.location;
        _salesPersonId = so.salesPersonId;
        _ledgerName = so.ledgerName;
        _orderNo.text = so.orderNo;
        _notes.text = so.notes ?? '';
        _orderDate = DateTime.tryParse(so.orderDate ?? '') ?? DateTime.now();
        _dueOn = DateTime.tryParse(so.dueOn ?? '');
        for (final r in _rows) {
          r.dispose();
        }
        _rows
          ..clear()
          ..addAll(so.items.map(_rowFromItem));
        if (_rows.isEmpty) _rows.add(LineRow());
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _loadError = e.message; _loading = false; });
    } catch (_) {
      if (mounted) {
        setState(() { _loadError = 'Could not load this sales order.'; _loading = false; });
      }
    }
  }

  LineRow _rowFromItem(VoucherItem it) {
    final r = LineRow()
      ..productId = it.productId
      ..productName = it.description;
    r.desc.text = it.description ?? '';
    r.qty.text = (it.quantity ?? 0).toString();
    r.rate.text = (it.rate ?? 0).toString();
    r.disc.text = (it.discountPct ?? 0).toString();
    r.gst.text = (it.gstRate ?? 0).toString();
    return r;
  }

  void _addRow() => setState(() => _rows.add(LineRow()));

  void _removeRow(LineRow r) {
    setState(() {
      _rows.remove(r);
      r.dispose();
    });
  }

  Future<void> _pickDate({required bool dueOn}) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: (dueOn ? _dueOn : _orderDate) ?? DateTime.now(),
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      if (dueOn) {
        _dueOn = picked;
      } else {
        _orderDate = picked;
      }
    });
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_customerId == null) {
      _snack('Customer is required.');
      return;
    }
    final items = <Map<String, dynamic>>[];
    for (final r in _rows) {
      final body = r.toBody();
      if (body != null) items.add(body);
    }
    if (items.isEmpty) {
      _snack('At least one line item with quantity and rate is required.');
      return;
    }

    final fmt = DateFormat('yyyy-MM-dd');
    final body = <String, dynamic>{
      'customer_id': _customerId,
      if (_locationId != null) 'location_id': _locationId,
      if (_salesPersonId != null) 'sales_person_id': _salesPersonId,
      if (_orderNo.text.trim().isNotEmpty) 'order_no': _orderNo.text.trim(),
      'order_date': fmt.format(_orderDate),
      if (_dueOn != null) 'due_on': fmt.format(_dueOn!),
      if (_ledgerName != null && _ledgerName!.isNotEmpty) 'ledger_name': _ledgerName,
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      'items': items,
    };

    setState(() => _busy = true);
    try {
      final repo = ref.read(salesOrderRepositoryProvider);
      if (_isEdit) {
        await repo.update(widget.orderId!, body);
      } else {
        await repo.create(body);
      }
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save this sales order.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final isSalesman = user?.isSalesman ?? false;
    final isCustomerUser = user?.isCustomerUser ?? false;
    final title = _isEdit ? 'Edit Sales Order' : 'Create Sales Order';
    final t = computeInvoiceTotals(_rows);

    if (_loading) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    if (_loadError != null) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.xl24),
            child: Text(_loadError!,
                textAlign: TextAlign.center,
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
          // Party — the customer scoping mirrors the API (a salesman sees only
          // their assigned customers; a portal login is locked to themselves).
          if (!isCustomerUser)
            SearchableFkDropdown(
              label: 'Customer *',
              endpoint: '/customers',
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
              Expanded(
                child: InvoiceDateField(
                  label: 'Date *',
                  value: _orderDate,
                  onTap: () => _pickDate(dueOn: false),
                ),
              ),
              const SizedBox(width: AppSpacing.md12),
              Expanded(
                child: InvoiceDateField(
                  label: 'Due On',
                  value: _dueOn,
                  onTap: () => _pickDate(dueOn: true),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _orderNo,
            label: 'Order No',
            hint: 'Auto-generated on save',
          ),
          const SizedBox(height: AppSpacing.md12),
          // "Ledger Type" — the Tally Sales-Accounts ledger this quote books
          // against. Same combobox the web shows.
          NameDropdown(
            label: 'Ledger Type',
            endpoint: '/tally/ledgers/sales-options',
            value: _ledgerName,
            onChanged: (v) => setState(() => _ledgerName = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          if (!isCustomerUser && !isSalesman)
            FkDropdown(
              label: 'Location',
              endpoint: '/locations',
              value: _locationId,
              onChanged: (v) => setState(() => _locationId = v),
            )
          else if (isSalesman)
            AppTextField(
              controller: TextEditingController(text: _locationName ?? ''),
              label: 'Location',
              hint: 'Auto from customer',
              enabled: false,
            ),
          if (!isCustomerUser) const SizedBox(height: AppSpacing.md12),
          if (!isCustomerUser && !isSalesman)
            FkDropdown(
              label: 'Sales Person',
              endpoint: '/sales-persons',
              value: _salesPersonId,
              onChanged: (v) => setState(() => _salesPersonId = v),
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
              lockPricing: isCustomerUser,
              onChanged: () => setState(() {}),
              onRemove: _rows.length > 1 ? () => _removeRow(row) : null,
            ),

          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _notes,
            label: 'Notes',
            hint: 'Delivery terms, packing, remarks…',
            maxLines: 3,
          ),
          const SizedBox(height: AppSpacing.md12),
          AppCard(
            child: Column(
              children: [
                _totalRow('Sub Total', t.subtotal, theme),
                if (t.discount > 0) _totalRow('Discount', -t.discount, theme),
                _totalRow('Taxes', t.tax, theme),
                const Divider(height: AppSpacing.lg16),
                _totalRow('Grand Total', t.total, theme, bold: true),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text(
            'Totals are recomputed by the server on save.',
            style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
          ),
          const SizedBox(height: AppSpacing.lg16),
          AppButton(
            label: _isEdit ? 'Update Sales Order' : 'Create Sales Order',
            loading: _busy,
            onPressed: _save,
          ),
        ],
      ),
    );
  }

  Widget _totalRow(String label, double value, ThemeData theme, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: bold
                  ? theme.textTheme.titleMedium
                  : theme.textTheme.bodySmall),
          Text(Fmt.inr(value),
              style: bold
                  ? theme.textTheme.titleMedium?.copyWith(color: AppColors.primary)
                  : theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}
