import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/searchable_picker.dart';

/// The full Customers advanced filter (mirrors the web's filter card): search,
/// GST, status, and three DYNAMIC dropdowns (Location / Sales Person / Customer
/// Group — fetched live from the API, never hard-coded), plus a created date
/// range. The server filters Location/SalesPerson/Group by NAME (FILTER_MAP),
/// so this returns names.
class CustomerFilter {
  const CustomerFilter({
    this.search,
    this.gst,
    this.status,
    this.location,
    this.salesPerson,
    this.customerGroup,
    this.from,
    this.to,
  });

  final String? search;
  final String? gst;
  final String? status;
  final String? location;
  final String? salesPerson;
  final String? customerGroup;
  final DateTime? from;
  final DateTime? to;

  bool get isActive =>
      [search, gst, status, location, salesPerson, customerGroup].any((e) => e != null && e.isNotEmpty) ||
      from != null ||
      to != null;

  /// Copy with a new search term (used by the list's top search box; the rest
  /// of the advanced filter is preserved).
  CustomerFilter copyWith({String? search}) => CustomerFilter(
        search: search,
        gst: gst,
        status: status,
        location: location,
        salesPerson: salesPerson,
        customerGroup: customerGroup,
        from: from,
        to: to,
      );
}

/// Fetch the {id,name} options from a paged list endpoint → just the names.
Future<List<String>> _names(WidgetRef ref, String endpoint) async {
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

Future<CustomerFilter?> showCustomerFilter(BuildContext context, WidgetRef ref, CustomerFilter current) {
  return showModalBottomSheet<CustomerFilter>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (ctx) => _CustomerFilterSheet(ref: ref, current: current),
  );
}

class _CustomerFilterSheet extends StatefulWidget {
  const _CustomerFilterSheet({required this.ref, required this.current});
  final WidgetRef ref;
  final CustomerFilter current;

  @override
  State<_CustomerFilterSheet> createState() => _CustomerFilterSheetState();
}

class _CustomerFilterSheetState extends State<_CustomerFilterSheet> {
  final _searchCtl = TextEditingController();
  final _gstCtl = TextEditingController();
  String? _status, _location, _salesPerson, _customerGroup;
  DateTime? _from, _to;

  List<String> _locations = [], _salesPersons = [], _groups = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _searchCtl.text = widget.current.search ?? '';
    _gstCtl.text = widget.current.gst ?? '';
    _status = widget.current.status;
    _location = widget.current.location;
    _salesPerson = widget.current.salesPerson;
    _customerGroup = widget.current.customerGroup;
    _from = widget.current.from;
    _to = widget.current.to;
    _loadOptions();
  }

  Future<void> _loadOptions() async {
    final results = await Future.wait([
      _names(widget.ref, Endpoints.locations),
      _names(widget.ref, Endpoints.salesPersons),
      _names(widget.ref, '/customer-groups'),
    ]);
    if (!mounted) return;
    setState(() {
      _locations = results[0];
      _salesPersons = results[1];
      _groups = results[2];
      _loading = false;
    });
  }

  @override
  void dispose() {
    _searchCtl.dispose();
    _gstCtl.dispose();
    super.dispose();
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
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
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

            _field('Search', TextField(controller: _searchCtl, decoration: _dec('Name, mobile, email…'))),
            _field('GST No.', TextField(controller: _gstCtl, decoration: _dec('Enter GST number'))),
            _field('Status', _dropdown(_status, const ['Active', 'Inactive', 'Blocked'], (v) => setState(() => _status = v))),
            _field('Location', _loading ? _loadingBox() : _searchableField(_location, 'Location', _locations, (v) => setState(() => _location = v))),
            _field('Sales Person', _loading ? _loadingBox() : _searchableField(_salesPerson, 'Sales Person', _salesPersons, (v) => setState(() => _salesPerson = v))),
            _field('Customer Group', _loading ? _loadingBox() : _searchableField(_customerGroup, 'Customer Group', _groups, (v) => setState(() => _customerGroup = v))),
            Row(
              children: [
                Expanded(child: _field('Created From', _dateField(_from, () => _pick(true)))),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: _field('Created To', _dateField(_to, () => _pick(false)))),
              ],
            ),

            const SizedBox(height: AppSpacing.sm8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => Navigator.pop(context, const CustomerFilter()),
                    icon: const Icon(Icons.restart_alt, size: 18),
                    label: const Text('Reset'),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => Navigator.pop(context, CustomerFilter(
                      search: _searchCtl.text.trim().isEmpty ? null : _searchCtl.text.trim(),
                      gst: _gstCtl.text.trim().isEmpty ? null : _gstCtl.text.trim(),
                      status: _status,
                      location: _location,
                      salesPerson: _salesPerson,
                      customerGroup: _customerGroup,
                      from: _from,
                      to: _to,
                    )),
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

  Widget _field(String label, Widget child) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.text2)),
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

  Widget _dropdown(String? value, List<String> options, ValueChanged<String?> onChanged) {
    return DropdownButtonFormField<String>(
      value: options.contains(value) ? value : null,
      isExpanded: true,
      decoration: _dec('All'),
      hint: const Text('All'),
      items: [
        const DropdownMenuItem<String>(value: null, child: Text('All')),
        for (final o in options) DropdownMenuItem<String>(value: o, child: Text(o, overflow: TextOverflow.ellipsis)),
      ],
      onChanged: onChanged,
    );
  }

  /// A tap-to-open searchable field for DYNAMIC option sets — shows the picked
  /// value (or "All"), opens [pickFromList] with a live search box on tap.
  Widget _searchableField(String? value, String title, List<String> options, ValueChanged<String?> onChanged) {
    final shown = (value == null || value.isEmpty) ? 'All' : value;
    final isAll = value == null || value.isEmpty;
    return InkWell(
      onTap: () async {
        final r = await pickFromList(context, title: title, options: options, current: value);
        if (r != null) onChanged(r.isEmpty ? null : r);
      },
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: Row(children: [
          Expanded(
            child: Text(shown,
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

  Widget _dateField(DateTime? value, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.sm8),
      child: Container(
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(AppRadius.sm8)),
        child: Row(children: [
          const Icon(Icons.calendar_today_outlined, size: 14, color: AppColors.text3),
          const SizedBox(width: 8),
          Text(value == null ? 'dd/mm/yyyy' : Fmt.date(value),
              style: TextStyle(fontSize: 13, color: value == null ? AppColors.text3 : AppColors.text1)),
        ]),
      ),
    );
  }
}
