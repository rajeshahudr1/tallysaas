import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/sales_person_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';

/// Add Sales Person form. Plain fields + an optional joining date (picked, sent
/// as an ISO `yyyy-MM-dd`). Submits `POST /sales-persons`, then pops `true` so
/// the list refreshes.
class SalesPersonFormScreen extends ConsumerStatefulWidget {
  const SalesPersonFormScreen({super.key});

  @override
  ConsumerState<SalesPersonFormScreen> createState() => _SalesPersonFormScreenState();
}

class _SalesPersonFormScreenState extends ConsumerState<SalesPersonFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _code = TextEditingController();
  final _mobile = TextEditingController();
  final _email = TextEditingController();

  String _status = 'Active';
  DateTime? _joiningDate;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _code, _mobile, _email]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _joiningDate ?? now,
      firstDate: DateTime(now.year - 50),
      lastDate: DateTime(now.year + 1),
    );
    if (picked != null) setState(() => _joiningDate = picked);
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(salesPersonRepositoryProvider).create({
        'name': _name.text.trim(),
        if (_code.text.trim().isNotEmpty) 'employee_code': _code.text.trim(),
        if (_mobile.text.trim().isNotEmpty) 'mobile': _mobile.text.trim(),
        if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
        if (_joiningDate != null)
          'joining_date': DateFormat('yyyy-MM-dd').format(_joiningDate!),
        'status': _status,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Sales person created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create sales person: $e');
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
    return Scaffold(
      appBar: AppBar(title: const Text('Add Sales Person')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            AppTextField(
              controller: _name, label: 'Name',
              prefixIcon: Icons.badge_outlined,
              validator: (v) => Validators.required(v, 'Name'),
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(controller: _code, label: 'Employee Code')),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(
                  controller: _mobile, label: 'Mobile',
                  keyboardType: TextInputType.phone,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _email, label: 'Email',
              keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? null : Validators.email(v),
            ),
            const SizedBox(height: AppSpacing.md12),

            // Joining date — tap to pick; optional.
            Text('Joining Date', style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            InkWell(
              onTap: _pickDate,
              borderRadius: BorderRadius.circular(AppRadius.sm8),
              child: InputDecorator(
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.event_outlined, size: 18),
                ),
                child: Text(
                  _joiningDate == null
                      ? 'Select date'
                      : DateFormat('dd/MM/yyyy').format(_joiningDate!),
                  style: _joiningDate == null
                      ? TextStyle(color: theme.hintColor)
                      : null,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.md12),

            Text('Status', style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            DropdownButtonFormField<String>(
              value: _status,
              items: const ['Active', 'Inactive']
                  .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                  .toList(),
              onChanged: (v) => setState(() => _status = v ?? 'Active'),
            ),
            const SizedBox(height: AppSpacing.xl24),

            AppButton(label: 'Save Sales Person', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}
