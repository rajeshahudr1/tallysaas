import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'app_text_field.dart';

/// Shared master-form building blocks so every form (Customers, Suppliers, …)
/// renders the SAME section headers + dynamic Custom Fields editor the web does,
/// without re-declaring private copies in each screen.

/// Section header that mirrors a web form tab (Basic Information, Address, …).
class FormSectionTitle extends StatelessWidget {
  const FormSectionTitle(this.text, {super.key, this.first = false});
  final String text;
  final bool first;
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(
            top: first ? 0 : AppSpacing.lg16, bottom: AppSpacing.sm8),
        child: Text(text,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppColors.primary, fontWeight: FontWeight.w700)),
      );
}

/// One custom-field key/value editor row's controllers (parent owns the list).
class CfRow {
  CfRow(String k, String v)
      : keyCtl = TextEditingController(text: k),
        valueCtl = TextEditingController(text: v);
  final TextEditingController keyCtl;
  final TextEditingController valueCtl;
  void dispose() {
    keyCtl.dispose();
    valueCtl.dispose();
  }
}

/// Build a `{key: value}` map from rows, skipping blank keys (matches the web's
/// custom_fields bag). Use at save time.
Map<String, dynamic> cfRowsToMap(List<CfRow> rows) {
  final m = <String, dynamic>{};
  for (final r in rows) {
    final k = r.keyCtl.text.trim();
    if (k.isNotEmpty) m[k] = r.valueCtl.text.trim();
  }
  return m;
}

/// Seed editor rows from a stored custom_fields map (edit mode).
List<CfRow> cfRowsFromMap(Map<String, dynamic> m) =>
    m.entries.map((e) => CfRow(e.key, e.value?.toString() ?? '')).toList();

/// Dynamic Custom Fields editor — renders each key/value row with a remove
/// button + an "Add field" action. The parent owns [rows] and rebuilds in the
/// [onAdd] / [onRemove] callbacks (setState).
class CustomFieldsEditor extends StatelessWidget {
  const CustomFieldsEditor({
    super.key,
    required this.rows,
    required this.onAdd,
    required this.onRemove,
  });
  final List<CfRow> rows;
  final VoidCallback onAdd;
  final void Function(int index) onRemove;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < rows.length; i++) ...[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: AppTextField(controller: rows[i].keyCtl, hint: 'Field name')),
              const SizedBox(width: AppSpacing.sm8),
              Expanded(child: AppTextField(controller: rows[i].valueCtl, hint: 'Value')),
              IconButton(
                onPressed: () => onRemove(i),
                icon: const Icon(Icons.close, color: AppColors.danger),
                tooltip: 'Remove',
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
        ],
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: onAdd,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('Add field'),
          ),
        ),
      ],
    );
  }
}
