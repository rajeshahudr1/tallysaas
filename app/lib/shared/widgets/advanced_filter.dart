import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import 'searchable_picker.dart';

/// A config-driven advanced filter sheet reused by EVERY list. Each screen
/// declares its [FilterField]s (the query keys + how to edit them); the sheet
/// renders them, fetches dynamic dropdown options live from the API, and
/// returns a `{queryKey: value}` map the controller forwards to the repo.
///
/// `dynamicSelect` fields are SEARCHABLE (a search box inside the picker) since
/// they can hold many options; `select` is a plain dropdown for short fixed
/// sets (Status, Yes/No). Dates are stored as `yyyy-MM-dd`.
enum FType { text, select, dynamicSelect, dateFrom, dateTo }

class FilterField {
  const FilterField(this.key, this.label, this.type,
      {this.options = const [], this.endpoint, this.hint, this.optionLabels = const {}});
  final String key; // the API query parameter
  final String label;
  final FType type;
  final List<String> options; // for FType.select — the VALUES sent to the API
  final String? endpoint; // for FType.dynamicSelect → fetch [{name}]
  final String? hint;
  final Map<String, String> optionLabels; // value → friendly label (select display)
}

Future<Map<String, String>?> showAdvancedFilter(
  BuildContext context,
  WidgetRef ref, {
  String title = 'Advanced filter',
  required List<FilterField> fields,
  required Map<String, String> current,
}) {
  return showModalBottomSheet<Map<String, String>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => _AdvancedFilterSheet(ref: ref, title: title, fields: fields, current: current),
  );
}

/// Fetch the option NAMES from a paged list endpoint (≤100 — the server caps it).
Future<List<String>> _fetchNames(WidgetRef ref, String endpoint) async {
  try {
    final data = await ref.read(apiClientProvider).get(endpoint, query: {'per_page': 100});
    final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
    return rows
        .map((r) => (r is Map ? '${r['name'] ?? ''}' : '').trim())
        .where((s) => s.isNotEmpty)
        .toSet()
        .toList()
      ..sort();
  } catch (_) {
    return const [];
  }
}

class _AdvancedFilterSheet extends StatefulWidget {
  const _AdvancedFilterSheet({required this.ref, required this.title, required this.fields, required this.current});
  final WidgetRef ref;
  final String title;
  final List<FilterField> fields;
  final Map<String, String> current;

  @override
  State<_AdvancedFilterSheet> createState() => _AdvancedFilterSheetState();
}

class _AdvancedFilterSheetState extends State<_AdvancedFilterSheet> {
  final Map<String, String> _values = {};
  final Map<String, TextEditingController> _text = {};
  final Map<String, List<String>> _options = {};
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      final v = widget.current[f.key];
      if (v != null && v.isNotEmpty) _values[f.key] = v;
      if (f.type == FType.text) _text[f.key] = TextEditingController(text: v ?? '');
    }
    _loadDynamic();
  }

  Future<void> _loadDynamic() async {
    final dyn = widget.fields.where((f) => f.type == FType.dynamicSelect && f.endpoint != null).toList();
    final results = await Future.wait(dyn.map((f) => _fetchNames(widget.ref, f.endpoint!)));
    if (!mounted) return;
    setState(() {
      for (var i = 0; i < dyn.length; i++) {
        _options[dyn[i].key] = results[i];
      }
      _loading = false;
    });
  }

  @override
  void dispose() {
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickDate(String key) async {
    final cur = DateTime.tryParse(_values[key] ?? '');
    final picked = await showDatePicker(
      context: context,
      initialDate: cur ?? DateTime(2023, 1, 1),
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() => _values[key] =
        '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}');
  }

  Map<String, String> _collect() {
    final out = <String, String>{};
    for (final f in widget.fields) {
      if (f.type == FType.text) {
        final t = _text[f.key]!.text.trim();
        if (t.isNotEmpty) out[f.key] = t;
      } else {
        final v = _values[f.key];
        if (v != null && v.isNotEmpty) out[f.key] = v;
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16,
        AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.tune, size: 18, color: AppColors.primary),
                const SizedBox(width: 8),
                Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
                const Spacer(),
                IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            for (final f in widget.fields) _fieldRow(f),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => Navigator.pop(context, <String, String>{}),
                    icon: const Icon(Icons.restart_alt, size: 18),
                    label: const Text('Reset'),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => Navigator.pop(context, _collect()),
                    icon: const Icon(Icons.filter_alt, size: 18),
                    label: const Text('Apply Filters'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _fieldRow(FilterField f) {
    Widget child;
    switch (f.type) {
      case FType.text:
        child = TextField(controller: _text[f.key], decoration: _dec(f.hint ?? 'Enter ${f.label.toLowerCase()}'));
        break;
      case FType.select:
        child = _staticDropdown(f);
        break;
      case FType.dynamicSelect:
        child = _loading ? _loadingBox() : _searchableField(f);
        break;
      case FType.dateFrom:
      case FType.dateTo:
        child = _dateField(f.key);
        break;
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(f.label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.text2)),
          const SizedBox(height: 5),
          child,
        ],
      ),
    );
  }

  InputDecoration _dec(String hint) => InputDecoration(
        hintText: hint,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.sm8)),
      );

  Widget _staticDropdown(FilterField f) {
    final v = _values[f.key];
    return DropdownButtonFormField<String>(
      value: f.options.contains(v) ? v : null,
      isExpanded: true,
      decoration: _dec('All'),
      hint: const Text('All'),
      items: [
        const DropdownMenuItem<String>(value: null, child: Text('All')),
        for (final o in f.options)
          DropdownMenuItem<String>(value: o, child: Text(f.optionLabels[o] ?? o, overflow: TextOverflow.ellipsis)),
      ],
      onChanged: (val) => setState(() {
        if (val == null) {
          _values.remove(f.key);
        } else {
          _values[f.key] = val;
        }
      }),
    );
  }

  Widget _searchableField(FilterField f) {
    final value = _values[f.key];
    final isAll = value == null || value.isEmpty;
    return InkWell(
      onTap: () async {
        final r = await pickFromList(context, title: f.label, options: _options[f.key] ?? const [], current: value);
        if (r != null) {
          setState(() {
            if (r.isEmpty) {
              _values.remove(f.key);
            } else {
              _values[f.key] = r;
            }
          });
        }
      },
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: Row(children: [
          Expanded(
            child: Text(isAll ? 'All' : value,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: isAll ? AppColors.text3 : AppColors.text1)),
          ),
          const Icon(Icons.arrow_drop_down, color: AppColors.text3),
        ]),
      ),
    );
  }

  Widget _loadingBox() => Container(
        height: 44,
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: const Row(children: [
          SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          SizedBox(width: 10),
          Text('Loading…', style: TextStyle(color: AppColors.text3, fontSize: 13)),
        ]),
      );

  Widget _dateField(String key) {
    final d = DateTime.tryParse(_values[key] ?? '');
    return InkWell(
      onTap: () => _pickDate(key),
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: Row(children: [
          const Icon(Icons.calendar_today_outlined, size: 14, color: AppColors.text3),
          const SizedBox(width: 8),
          Text(d == null ? 'dd/mm/yyyy' : Fmt.date(d),
              style: TextStyle(fontSize: 13, color: d == null ? AppColors.text3 : AppColors.text1)),
        ]),
      ),
    );
  }
}
