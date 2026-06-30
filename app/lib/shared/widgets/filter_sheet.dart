import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';

/// The result of an advanced-filter sheet. `cleared` distinguishes "Clear all"
/// (reset everything) from a normal Apply.
class FilterResult {
  const FilterResult({this.status, this.from, this.to, this.cleared = false});
  final String? status;
  final DateTime? from;
  final DateTime? to;
  final bool cleared;
}

/// A reusable "Advanced filter" bottom sheet. Shows a Status chooser (when
/// [statusOptions] is given) and/or a From/To date range (when [dateRange]).
/// Returns the chosen filters, or null if dismissed without applying.
Future<FilterResult?> showFilterSheet(
  BuildContext context, {
  List<String>? statusOptions,
  String? currentStatus,
  bool dateRange = false,
  DateTime? currentFrom,
  DateTime? currentTo,
}) {
  return showModalBottomSheet<FilterResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (ctx) => _FilterSheet(
      statusOptions: statusOptions,
      currentStatus: currentStatus,
      dateRange: dateRange,
      currentFrom: currentFrom,
      currentTo: currentTo,
    ),
  );
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({
    this.statusOptions,
    this.currentStatus,
    this.dateRange = false,
    this.currentFrom,
    this.currentTo,
  });
  final List<String>? statusOptions;
  final String? currentStatus;
  final bool dateRange;
  final DateTime? currentFrom;
  final DateTime? currentTo;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  String? _status;
  DateTime? _from;
  DateTime? _to;

  @override
  void initState() {
    super.initState();
    _status = widget.currentStatus;
    _from = widget.currentFrom;
    _to = widget.currentTo;
  }

  Future<void> _pick(bool isFrom) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: (isFrom ? _from : _to) ?? DateTime(2023, 1, 1),
      firstDate: DateTime(2015),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      if (isFrom) {
        _from = picked;
        if (_to != null && _to!.isBefore(_from!)) _to = _from;
      } else {
        _to = picked;
        if (_from != null && _from!.isAfter(_to!)) _from = _to;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16,
        AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.tune, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              const Text('Advanced filter', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),

          if (widget.statusOptions != null && widget.statusOptions!.isNotEmpty) ...[
            const Text('Status', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.text2)),
            const SizedBox(height: AppSpacing.sm8),
            Wrap(
              spacing: 8,
              children: [
                _chip('All', _status == null, () => setState(() => _status = null)),
                for (final s in widget.statusOptions!)
                  _chip(s, _status == s, () => setState(() => _status = s)),
              ],
            ),
            const SizedBox(height: AppSpacing.lg16),
          ],

          if (widget.dateRange) ...[
            const Text('Date range', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.text2)),
            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(child: _dateField('From', _from, () => _pick(true))),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: _dateField('To', _to, () => _pick(false))),
              ],
            ),
            const SizedBox(height: AppSpacing.lg16),
          ],

          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.pop(context, const FilterResult(cleared: true)),
                  child: const Text('Clear all'),
                ),
              ),
              const SizedBox(width: AppSpacing.sm8),
              Expanded(
                child: FilledButton(
                  onPressed: () => Navigator.pop(context, FilterResult(status: _status, from: _from, to: _to)),
                  child: const Text('Apply'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, bool selected, VoidCallback onTap) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      selectedColor: AppColors.primary.withOpacity(0.15),
      labelStyle: TextStyle(color: selected ? AppColors.primary : AppColors.text2, fontWeight: selected ? FontWeight.w600 : FontWeight.w400),
    );
  }

  Widget _dateField(String label, DateTime? value, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: Row(
          children: [
            const Icon(Icons.calendar_today_outlined, size: 14, color: AppColors.text3),
            const SizedBox(width: 8),
            Text('$label: ${value == null ? 'Any' : Fmt.date(value)}', style: const TextStyle(fontSize: 13, color: AppColors.text1)),
          ],
        ),
      ),
    );
  }
}
