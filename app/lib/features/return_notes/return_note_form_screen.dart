import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/return_note.dart';
import '../../data/models/voucher_item.dart';
import '../../data/repositories/return_note_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/brand_primitives.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart';
import '../transactions/price_level.dart';

/// Create / edit a credit or debit note. One form for both kinds — the party
/// (customer vs supplier) and the supplier-bill field are the only differences,
/// matching how the API branches on `kind`.
class ReturnNoteFormScreen extends ConsumerStatefulWidget {
  const ReturnNoteFormScreen({super.key, required this.kind, this.noteId});

  final ReturnNoteKind kind;

  /// Null → create; set → edit that note.
  final int? noteId;

  @override
  ConsumerState<ReturnNoteFormScreen> createState() => _ReturnNoteFormScreenState();
}

class _ReturnNoteFormScreenState extends ConsumerState<ReturnNoteFormScreen> {
  final _supplierBillNo = TextEditingController();
  final _notes = TextEditingController();

  int? _partyId;
  int? _locationId;
  String? _locationName;
  DateTime _noteDate = DateTime.now();  /// Tally's per-tier rate card, when the company uses them. Null = the
  /// item's own standard price.
  String? _priceLevel;

  /// The chosen party's synced closing balance, shown under the picker.
  double? _partyBalance;


  final List<LineRow> _rows = [];

  bool _busy = false;
  bool _loading = false;
  String? _loadError;

  ReturnNoteKind get _kind => widget.kind;
  bool get _isEdit => widget.noteId != null;

  @override
  void initState() {
    super.initState();
    if (_isEdit) {
      _load();
    } else {
      _rows.add(LineRow());
    }
  }

  @override
  void dispose() {
    _supplierBillNo.dispose();
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
      final n = await ref
          .read(returnNoteRepositoryProvider(_kind))
          .get(widget.noteId!);
      if (!mounted) return;
      setState(() {
        _partyId = n.partyId(_kind);
        _locationId = n.locationId;
        _locationName = n.location;
        _supplierBillNo.text = n.supplierBillNo ?? '';
        _notes.text = n.notes ?? '';
        _noteDate = DateTime.tryParse(n.invoiceDate ?? '') ?? DateTime.now();
        for (final r in _rows) {
          r.dispose();
        }
        _rows
          ..clear()
          ..addAll(n.items.map(_rowFromItem));
        if (_rows.isEmpty) _rows.add(LineRow());
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _loadError = e.message; _loading = false; });
    } catch (_) {
      if (mounted) {
        setState(() {
          _loadError = 'Could not load this ${_kind.singular.toLowerCase()}.';
          _loading = false;
        });
      }
    }
  }

  LineRow _rowFromItem(VoucherItem it) {
    final r = LineRow()
      ..productId = it.productId
      ..productName = it.description
      // Keep the HSN/unit the voucher was saved with — re-picking the product
      // would overwrite them from the master, which may have changed since.
      ..hsn = it.hsn
      ..unit = it.unit;
    r.desc.text = it.description ?? '';
    r.qty.text = (it.quantity ?? 0).toString();
    r.rate.text = (it.rate ?? 0).toString();
    r.disc.text = (it.discountPct ?? 0).toString();
    r.gst.text = (it.gstRate ?? 0).toString();
    return r;
  }  /// Re-price every line that already has an item. Changing the level
  /// after the lines are entered has to move their rates too, or the
  /// voucher says one thing at the top and another in the middle.
  void _reapplyPriceLevel() {
    var changed = false;
    for (final r in _rows) {
      final name = r.productName;
      if (name == null || name.isEmpty) continue;
      final rate = _levelRateFor(name, double.tryParse(r.qty.text.trim()) ?? 0);
      if (rate == null) continue;
      final text = rate == rate.roundToDouble() ? rate.toInt().toString() : rate.toString();
      if (r.rate.text != text) { r.rate.text = text; changed = true; }
    }
    if (changed && mounted) setState(() {});
  }

  /// The active price level's rate for an item at a quantity, or null when
  /// no level is chosen or the level says nothing about that item.
  double? _levelRateFor(String itemName, double qty) {
    final level = _priceLevel;
    if (level == null || level.isEmpty) return null;
    final card = ref.read(priceCardProvider(level)).valueOrNull;
    return card?.rateFor(itemName, qty);
  }


  void _addRow() => setState(() => _rows.add(LineRow()));

  void _removeRow(LineRow r) {
    setState(() {
      _rows.remove(r);
      r.dispose();
    });
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _noteDate,
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked != null) setState(() => _noteDate = picked);
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_partyId == null) {
      _snack('${_kind.partyLabel} is required.');
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

    final body = <String, dynamic>{
      _kind.partyKey: _partyId,
      if (_locationId != null) 'location_id': _locationId,
      'invoice_date': DateFormat('yyyy-MM-dd').format(_noteDate),
      if (!_kind.isCredit && _supplierBillNo.text.trim().isNotEmpty)
        'supplier_bill_no': _supplierBillNo.text.trim(),
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      'items': items,
    };

    setState(() => _busy = true);
    try {
      final repo = ref.read(returnNoteRepositoryProvider(_kind));
      if (_isEdit) {
        await repo.update(widget.noteId!, body);
      } else {
        await repo.create(body);
      }
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save this ${_kind.singular.toLowerCase()}.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // A salesman can't list locations (403) — theirs auto-fills from the party.
    final isSalesman = user?.isSalesman ?? false;
    final title = '${_isEdit ? 'Edit' : 'Create'} ${_kind.singular}';    // WATCH (not read) the chosen level: a FutureProvider only fetches
    // once something is listening, and the rows are re-rated the moment
    // the card lands.
    final level = _priceLevel;
    if (level != null && level.isNotEmpty) {
      ref.listen(priceCardProvider(level), (_, next) {
        if (next.hasValue) _reapplyPriceLevel();
      });
      ref.watch(priceCardProvider(level));
    }

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
          // The same gradient header the web leads its voucher forms with.
          GradientHeader(
            title: title,
            subtitle: _isEdit
                ? 'Update the details of this ${_kind.singular.toLowerCase()}'
                : 'Fill in the details to create a new ${_kind.singular.toLowerCase()}',
          ),
          const SizedBox(height: AppSpacing.lg16),
          SearchableFkDropdown(
            label: '${_kind.partyLabel} *',
            endpoint: _kind.partyEndpoint,
            value: _partyId,
            onChanged: (v) => setState(() => _partyId = v),
            onItem: (o) => setState(() {
              _partyBalance = o?.balance;
              if (o?.locationId != null) {
                _locationId = o!.locationId;
                _locationName = o.locationName;
              }
            }),
          ),
          PartyBalanceLine(balance: _partyBalance),
          PriceLevelPicker(
            value: _priceLevel,
            onChanged: (v) => setState(() => _priceLevel = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          InvoiceDateField(
            label: 'Date *',
            value: _noteDate,
            onTap: _pickDate,
          ),
          const SizedBox(height: AppSpacing.md12),
          if (!_kind.isCredit) ...[
            AppTextField(
              controller: _supplierBillNo,
              label: 'Supplier Bill No',
              hint: "The supplier's own reference",
            ),
            const SizedBox(height: AppSpacing.md12),
          ],
          if (!isSalesman)
            FkDropdown(
              label: 'Location',
              endpoint: '/locations',
              value: _locationId,
              onChanged: (v) => setState(() => _locationId = v),
            )
          else
            AppTextField(
              controller: TextEditingController(text: _locationName ?? ''),
              label: 'Location',
              hint: 'Auto from party',
              enabled: false,
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
              rateFor: _levelRateFor,
              onChanged: () => setState(() {}),
              onRemove: _rows.length > 1 ? () => _removeRow(row) : null,
            ),

          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _notes,
            label: 'Notes',
            hint: 'Reason for the return…',
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
            label: '${_isEdit ? 'Update' : 'Create'} ${_kind.singular}',
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
              style: bold ? theme.textTheme.titleMedium : theme.textTheme.bodySmall),
          Text(Fmt.inr(value),
              style: bold
                  ? theme.textTheme.titleMedium?.copyWith(color: AppColors.primary)
                  : theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}
