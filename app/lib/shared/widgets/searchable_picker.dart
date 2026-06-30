import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// A searchable single-select picker shown as a bottom sheet — used by the
/// advanced filters for DYNAMIC dropdowns that can hold many options (Location,
/// Sales Person, Customer Group, Category…). Fixed/short option sets (Status,
/// Yes/No) keep the plain dropdown; this one adds a live search box.
///
/// Returns:
///   • `null`  → the user cancelled (no change)
///   • `''`    → the user chose "All" (clear this filter)
///   • a name  → the chosen option
Future<String?> pickFromList(
  BuildContext context, {
  required String title,
  required List<String> options,
  String? current,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => _SearchablePicker(title: title, options: options, current: current),
  );
}

class _SearchablePicker extends StatefulWidget {
  const _SearchablePicker({required this.title, required this.options, this.current});
  final String title;
  final List<String> options;
  final String? current;

  @override
  State<_SearchablePicker> createState() => _SearchablePickerState();
}

class _SearchablePickerState extends State<_SearchablePicker> {
  final _searchCtl = TextEditingController();
  String _q = '';

  @override
  void dispose() {
    _searchCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.trim().toLowerCase();
    final filtered = q.isEmpty
        ? widget.options
        : widget.options.where((o) => o.toLowerCase().contains(q)).toList();
    final maxH = MediaQuery.of(context).size.height * 0.7;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.sm8),
              child: Row(
                children: [
                  Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
                  const Spacer(),
                  IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg16),
              child: TextField(
                controller: _searchCtl,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'Search…',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  isDense: true,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.sm8)),
                ),
                onChanged: (v) => setState(() => _q = v),
              ),
            ),
            const SizedBox(height: AppSpacing.sm8),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  // "All" clears the filter.
                  ListTile(
                    dense: true,
                    leading: Icon(widget.current == null || widget.current!.isEmpty ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                        size: 20, color: AppColors.primary),
                    title: const Text('All'),
                    onTap: () => Navigator.pop(context, ''),
                  ),
                  if (filtered.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(AppSpacing.lg16),
                      child: Text('No matches', style: TextStyle(color: AppColors.text3)),
                    ),
                  for (final o in filtered)
                    ListTile(
                      dense: true,
                      leading: Icon(o == widget.current ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                          size: 20, color: o == widget.current ? AppColors.primary : AppColors.text3),
                      title: Text(o),
                      onTap: () => Navigator.pop(context, o),
                    ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ),
      ),
    );
  }
}
