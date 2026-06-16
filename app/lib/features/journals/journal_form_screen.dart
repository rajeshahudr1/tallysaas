import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/journal_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../transactions/invoice_form_parts.dart' show InvoiceDateField;

/// New Journal voucher — a two-ledger Dr/Cr entry. Voucher type comes from
/// `GET /config/options` (journal_vch_types). Ledger names are free text (they
/// match Tally ledger names on sync). Submits `POST /journals`, then pops `true`.
class JournalFormScreen extends ConsumerStatefulWidget {
  const JournalFormScreen({super.key});

  @override
  ConsumerState<JournalFormScreen> createState() => _JournalFormScreenState();
}

class _JournalFormScreenState extends ConsumerState<JournalFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _drLedger = TextEditingController();
  final _crLedger = TextEditingController();
  final _amount = TextEditingController();
  final _narration = TextEditingController();

  String? _vchType = 'Journal';
  DateTime _date = _today();
  bool _busy = false;

  static DateTime _today() {
    final n = DateTime.now();
    return DateTime(n.year, n.month, n.day);
  }

  @override
  void dispose() {
    for (final c in [_drLedger, _crLedger, _amount, _narration]) {
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
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final amt = double.tryParse(_amount.text.trim());
    if (amt == null || amt <= 0) {
      _showError('Enter a valid amount greater than 0.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(journalRepositoryProvider).create({
        if (_vchType != null) 'vch_type': _vchType,
        'journal_date': DateFormat('yyyy-MM-dd').format(_date),
        'dr_ledger': _drLedger.text.trim(),
        'cr_ledger': _crLedger.text.trim(),
        'amount': amt,
        if (_narration.text.trim().isNotEmpty) 'narration': _narration.text.trim(),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Journal voucher created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create journal: $e');
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
      appBar: AppBar(title: const Text('New Journal')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            Row(
              children: [
                Expanded(child: ConfigDropdown(
                  label: 'Type', configKey: 'journal_vch_types',
                  value: _vchType, onChanged: (v) => setState(() => _vchType = v),
                )),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: InvoiceDateField(
                  label: 'Date *', value: _date, onTap: _pickDate,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _drLedger, label: 'Debit Ledger (Dr)',
              prefixIcon: Icons.arrow_downward,
              validator: (v) => Validators.required(v, 'Debit ledger'),
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _crLedger, label: 'Credit Ledger (Cr)',
              prefixIcon: Icons.arrow_upward,
              validator: (v) => Validators.required(v, 'Credit ledger'),
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _amount, label: 'Amount *',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              prefixIcon: Icons.currency_rupee,
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _narration, label: 'Narration', maxLines: 2),
            const SizedBox(height: AppSpacing.xl24),

            AppButton(label: 'Save Journal', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}
