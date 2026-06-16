import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/repositories/payment_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart' show InvoiceDateField;

/// Generic voucher form — drives BOTH "New Payment" (money out to a supplier)
/// and "New Receipt" (money in from a customer). The only differences are the
/// party FK ([partyKey] / [partyLabel] / [partyEndpoint]) and the [basePath]
/// it POSTs to. Mode comes from `GET /config/options` (payment_modes) — nothing
/// hardcoded. Pops `true` to refresh the list.
class VoucherFormScreen extends ConsumerStatefulWidget {
  const VoucherFormScreen({
    super.key,
    required this.title,
    required this.basePath,
    required this.partyKey,
    required this.partyLabel,
    required this.partyEndpoint,
    required this.saveLabel,
  });

  final String title;
  final String basePath;     // '/payments' | '/receipts'
  final String partyKey;     // 'supplier_id' | 'customer_id'
  final String partyLabel;   // 'Supplier *' | 'Customer *'
  final String partyEndpoint; // '/suppliers' | '/customers'
  final String saveLabel;

  @override
  ConsumerState<VoucherFormScreen> createState() => _VoucherFormScreenState();
}

class _VoucherFormScreenState extends ConsumerState<VoucherFormScreen> {
  int? _partyId;
  DateTime _date = _today();
  String? _mode;
  final _amount = TextEditingController();
  final _reference = TextEditingController();
  final _bankAccount = TextEditingController();
  final _notes = TextEditingController();
  bool _busy = false;

  static DateTime _today() {
    final n = DateTime.now();
    return DateTime(n.year, n.month, n.day);
  }

  @override
  void dispose() {
    for (final c in [_amount, _reference, _bankAccount, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(_date.year - 5),
      lastDate: DateTime(_date.year + 5),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_partyId == null) {
      _showError('Please select a ${widget.partyLabel.replaceAll(' *', '').toLowerCase()}.');
      return;
    }
    if (_mode == null) {
      _showError('Please select a payment mode.');
      return;
    }
    final amt = double.tryParse(_amount.text.trim());
    if (amt == null || amt <= 0) {
      _showError('Enter a valid amount greater than 0.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(paymentRepositoryProvider).create(widget.basePath, {
        widget.partyKey: _partyId,
        'payment_date': DateFormat('yyyy-MM-dd').format(_date),
        'mode': _mode,
        'amount': amt,
        if (_reference.text.trim().isNotEmpty) 'reference': _reference.text.trim(),
        if (_bankAccount.text.trim().isNotEmpty) 'bank_account': _bankAccount.text.trim(),
        if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('${widget.saveLabel} saved.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save: $e');
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
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          FkDropdown(
            label: widget.partyLabel, endpoint: widget.partyEndpoint,
            value: _partyId, onChanged: (v) => setState(() => _partyId = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          Row(
            children: [
              Expanded(child: InvoiceDateField(
                label: 'Date *', value: _date, onTap: _pickDate,
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: ConfigDropdown(
                label: 'Mode *', configKey: 'payment_modes',
                value: _mode, onChanged: (v) => setState(() => _mode = v),
              )),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _amount, label: 'Amount *',
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            prefixIcon: Icons.currency_rupee,
          ),
          const SizedBox(height: AppSpacing.md12),
          Row(
            children: [
              Expanded(child: AppTextField(controller: _reference, label: 'Reference')),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: AppTextField(controller: _bankAccount, label: 'Bank Account')),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(controller: _notes, label: 'Notes', maxLines: 2),
          const SizedBox(height: AppSpacing.xl24),

          AppButton(label: widget.saveLabel, loading: _busy, onPressed: _save),
        ],
      ),
    );
  }
}
