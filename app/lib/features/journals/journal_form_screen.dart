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

/// New Journal / Contra voucher — a two-ledger Dr/Cr entry. Ledger names are
/// free text (they match Tally ledger names on sync). Submits to the scope's
/// endpoint, then pops `true`.
///
/// Journals let the user pick the voucher type from `GET /config/options`
/// (journal_vch_types). A CONTRA is a cash⇄bank transfer — the API forces
/// `vch_type: 'Contra'` at the route level, so the picker is hidden there.
class JournalFormScreen extends ConsumerStatefulWidget {
  const JournalFormScreen({super.key, this.scope = JournalScope.journals});
  final JournalScope scope;

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
  bool get _isContra => widget.scope == JournalScope.contra;
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
      await ref.read(journalRepositoryProvider(widget.scope)).create({
        // Contra: the API forces the type; sending it is harmless but pointless.
        if (!_isContra && _vchType != null) 'vch_type': _vchType,
        'journal_date': DateFormat('yyyy-MM-dd').format(_date),
        'dr_ledger': _drLedger.text.trim(),
        'cr_ledger': _crLedger.text.trim(),
        'amount': amt,
        if (_narration.text.trim().isNotEmpty) 'narration': _narration.text.trim(),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text('${widget.scope.singular} voucher created.')));
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
      appBar: AppBar(title: Text('New ${widget.scope.singular}')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            if (_isContra)
              InvoiceDateField(label: 'Date *', value: _date, onTap: _pickDate)
            else
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
              controller: _drLedger,
              label: _isContra ? 'To (Dr)' : 'Debit Ledger (Dr)',
              prefixIcon: Icons.arrow_downward,
              validator: (v) => Validators.required(v, 'Debit ledger'),
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _crLedger,
              label: _isContra ? 'From (Cr)' : 'Credit Ledger (Cr)',
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

            AppButton(
              label: 'Save ${widget.scope.singular}',
              loading: _busy,
              onPressed: _save,
            ),
          ],
        ),
      ),
    );
  }
}
