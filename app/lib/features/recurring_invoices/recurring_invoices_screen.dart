import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Recurring Invoices — templates that auto-generate a sales invoice on a
/// schedule. List + add/edit sheet + Generate-now + delete. Mirrors the web.
final _recurringProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/recurring-invoices', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

final _recCustomersProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/customers', query: {'per_page': 200});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

const _kGreen = Color(0xFF16A34A);
const _kFreq = ['monthly', 'quarterly', 'yearly'];

/// A template + the invoices it has generated (GET /recurring-invoices/:id/invoices).
final _recDetailProvider = FutureProvider.autoDispose
    .family<Map<String, dynamic>, int>((ref, id) async {
  final data = await ref.read(apiClientProvider).get('/recurring-invoices/$id/invoices');
  return data is Map ? data.cast<String, dynamic>() : <String, dynamic>{};
});

String _fmtDate(dynamic d) {
  final s = d == null ? '' : '$d';
  if (s.length < 10) return s.isEmpty ? '—' : s;
  return s.substring(0, 10).split('-').reversed.join('/');
}

String _cap(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

class RecurringInvoicesScreen extends ConsumerWidget {
  const RecurringInvoicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_recurringProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Recurring Invoices'), actions: const [ModuleInfoButton('recurring')]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _addOrEdit(context, ref, null),
        icon: const Icon(Icons.add),
        label: const Text('New'),
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load recurring invoices.',
          onRetry: () => ref.invalidate(_recurringProvider),
        ),
        data: (list) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(_recurringProvider),
          child: list.isEmpty
              ? ListView(children: const [
                  Padding(
                    padding: EdgeInsets.only(top: 120),
                    child: Center(child: Text('No recurring invoices yet.\nTap "New" to add one.',
                        textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3))),
                  ),
                ])
              : ListView(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32 + 40),
                  children: [
                    for (final r in list)
                      Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _RecurringCard(r,
                            onEdit: () => _addOrEdit(context, ref, r),
                            onDelete: () => _delete(context, ref, r),
                            onGenerate: () => _generate(context, ref, r),
                            onView: () => _view(context, r)),
                      ),
                  ],
                ),
        ),
      ),
    );
  }

  Future<void> _addOrEdit(BuildContext context, WidgetRef ref, Map<String, dynamic>? existing) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _RecurringSheet(existing: existing),
    );
    if (ok == true) ref.invalidate(_recurringProvider);
  }

  Future<void> _generate(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    final yes = await ConfirmDialog.show(context,
        title: 'Generate invoice now?',
        message: 'A new sales invoice will be created from "${r['title'] ?? ''}".',
        confirmLabel: 'Generate');
    if (!yes) return;
    try {
      final res = await ref.read(apiClientProvider).post('/recurring-invoices/${r['id']}/generate', body: {});
      ref.invalidate(_recurringProvider);
      if (context.mounted) {
        final no = (res is Map && res['invoice_no'] != null) ? res['invoice_no'] : null;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(no != null ? 'Invoice $no generated.' : 'Invoice generated.')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not generate: $e')));
      }
    }
  }

  /// View a template's schedule + the invoices it has generated (bottom sheet).
  void _view(BuildContext context, Map<String, dynamic> r) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _RecurringDetailSheet(template: r),
    );
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    final yes = await ConfirmDialog.show(context,
        title: 'Delete this template?', message: 'Already-generated invoices are kept.', confirmLabel: 'Delete', danger: true);
    if (!yes) return;
    try {
      await ref.read(apiClientProvider).delete('/recurring-invoices/${r['id']}');
      ref.invalidate(_recurringProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Deleted.')));
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not delete: $e')));
      }
    }
  }
}

class _RecurringCard extends StatelessWidget {
  const _RecurringCard(this.r, {required this.onEdit, required this.onDelete, required this.onGenerate, required this.onView});
  final Map<String, dynamic> r;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final VoidCallback onGenerate;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = '${r['status'] ?? ''}' == 'Active';
    final customer = '${r['customer'] ?? ''}';
    final gst = Fmt.n(r['gst_rate']).toDouble();
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${r['title'] ?? ''}', style: theme.textTheme.titleMedium),
                    if (customer.isNotEmpty) Text(customer, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                  ],
                ),
              ),
              Text(Fmt.inr(r['amount']), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
              if (gst > 0) Padding(padding: const EdgeInsets.only(left: 4), child: Text('+${gst.toStringAsFixed(gst == gst.roundToDouble() ? 0 : 2)}%', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3))),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          Row(children: [
            _chip(_cap('${r['frequency'] ?? ''}'), AppColors.primary),
            const SizedBox(width: 8),
            Text('Next: ${_fmtDate(r['next_run_date'])}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
              decoration: BoxDecoration(color: (active ? _kGreen : AppColors.text3).withOpacity(0.12), borderRadius: BorderRadius.circular(999)),
              child: Text('${r['status'] ?? ''}', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: active ? _kGreen : AppColors.text3)),
            ),
          ]),
          const Divider(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(onPressed: onView, icon: const Icon(Icons.visibility_outlined, size: 18), label: const Text('View'), style: TextButton.styleFrom(foregroundColor: AppColors.text2)),
              TextButton.icon(onPressed: onGenerate, icon: const Icon(Icons.bolt, size: 18), label: const Text('Generate'), style: TextButton.styleFrom(foregroundColor: AppColors.primary)),
              IconButton(icon: const Icon(Icons.edit_outlined, size: 20), color: AppColors.text2, onPressed: onEdit),
              IconButton(icon: const Icon(Icons.delete_outline, size: 20), color: AppColors.danger, onPressed: onDelete),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
        decoration: BoxDecoration(color: c.withOpacity(0.10), borderRadius: BorderRadius.circular(999)),
        child: Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c)),
      );
}

class _RecurringSheet extends ConsumerStatefulWidget {
  const _RecurringSheet({this.existing});
  final Map<String, dynamic>? existing;
  @override
  ConsumerState<_RecurringSheet> createState() => _RecurringSheetState();
}

class _RecurringSheetState extends ConsumerState<_RecurringSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _description;
  late final TextEditingController _amount;
  late final TextEditingController _gst;
  late final TextEditingController _dueDays;
  int? _customerId;
  String _frequency = 'monthly';
  String _status = 'Active';
  DateTime? _date;   // start_date (add) / next_run_date (edit)
  DateTime? _endDate;
  bool _busy = false;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _title = TextEditingController(text: '${e?['title'] ?? ''}');
    _description = TextEditingController(text: '${e?['description'] ?? ''}');
    _amount = TextEditingController(text: e?['amount'] != null ? '${e!['amount']}' : '');
    _gst = TextEditingController(text: '${e?['gst_rate'] ?? 0}');
    _dueDays = TextEditingController(text: '${e?['due_days'] ?? 0}');
    _customerId = (e?['customer_id'] as num?)?.toInt();
    final f = '${e?['frequency'] ?? 'monthly'}';
    _frequency = _kFreq.contains(f) ? f : 'monthly';
    _status = '${e?['status'] ?? 'Active'}';
    final d = '${(e?['next_run_date'] ?? e?['start_date']) ?? ''}';
    if (d.length >= 10) _date = DateTime.tryParse(d.substring(0, 10));
    final ed = '${e?['end_date'] ?? ''}';
    if (ed.length >= 10) _endDate = DateTime.tryParse(ed.substring(0, 10));
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    _amount.dispose();
    _gst.dispose();
    _dueDays.dispose();
    super.dispose();
  }

  String? _ymd(DateTime? d) => d == null ? null : '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_date == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please pick a start / next-run date.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final body = <String, dynamic>{
        'customer_id': _customerId,
        'title': _title.text.trim(),
        'description': _description.text.trim(),
        'amount': double.tryParse(_amount.text.trim()) ?? 0,
        'gst_rate': double.tryParse(_gst.text.trim()) ?? 0,
        'frequency': _frequency,
        'due_days': int.tryParse(_dueDays.text.trim()) ?? 0,
        'end_date': _ymd(_endDate),
        'status': _status,
      };
      if (_isEdit) {
        body['next_run_date'] = _ymd(_date);
      } else {
        body['start_date'] = _ymd(_date);
      }
      final api = ref.read(apiClientProvider);
      if (_isEdit) {
        await api.put('/recurring-invoices/${widget.existing!['id']}', body: body);
      } else {
        await api.post('/recurring-invoices', body: body);
      }
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_isEdit ? 'Updated.' : 'Recurring invoice created.')));
    } on ApiException catch (e) {
      _err(e.message);
    } catch (e) {
      _err('Could not save: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _err(String m) {
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    final custs = ref.watch(_recCustomersProvider);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Text(_isEdit ? 'Edit Recurring' : 'New Recurring Invoice', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
                const Spacer(),
                IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
              ]),
              const SizedBox(height: AppSpacing.sm8),
              AppTextField(controller: _title, label: 'Title *', prefixIcon: Icons.title,
                  validator: (v) => (v == null || v.trim().isEmpty) ? 'Title is required' : null),
              const SizedBox(height: AppSpacing.md12),
              const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Customer', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
              custs.maybeWhen(
                data: (list) => DropdownButtonFormField<int?>(
                  value: _customerId,
                  isExpanded: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline, size: 18)),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('— Select —')),
                    ...list.map((c) => DropdownMenuItem<int?>(value: (c['id'] as num).toInt(), child: Text('${c['name'] ?? ''}', overflow: TextOverflow.ellipsis))),
                  ],
                  onChanged: (v) => setState(() => _customerId = v),
                ),
                orElse: () => DropdownButtonFormField<int?>(
                  value: null,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline, size: 18)),
                  items: const [DropdownMenuItem<int?>(value: null, child: Text('— Select —'))],
                  onChanged: null,
                ),
              ),
              const SizedBox(height: AppSpacing.md12),
              Row(children: [
                Expanded(child: AppTextField(controller: _amount, label: 'Amount *', keyboardType: const TextInputType.numberWithOptions(decimal: true), prefixIcon: Icons.currency_rupee,
                    validator: (v) => (double.tryParse((v ?? '').trim()) == null) ? 'Enter amount' : null)),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: AppTextField(controller: _gst, label: 'GST %', keyboardType: const TextInputType.numberWithOptions(decimal: true), prefixIcon: Icons.percent)),
              ]),
              const SizedBox(height: AppSpacing.md12),
              const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Frequency', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
              DropdownButtonFormField<String>(
                value: _frequency,
                isExpanded: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.repeat, size: 18)),
                items: _kFreq.map((f) => DropdownMenuItem<String>(value: f, child: Text(_cap(f)))).toList(),
                onChanged: (v) => setState(() => _frequency = v ?? 'monthly'),
              ),
              const SizedBox(height: AppSpacing.md12),
              Row(children: [
                Expanded(child: _dateField(context, _isEdit ? 'Next Run *' : 'Start Date *', _date, (d) => setState(() => _date = d))),
                const SizedBox(width: AppSpacing.sm8),
                Expanded(child: AppTextField(controller: _dueDays, label: 'Due in (days)', keyboardType: TextInputType.number, prefixIcon: Icons.event_available_outlined)),
              ]),
              const SizedBox(height: AppSpacing.md12),
              _dateField(context, 'End Date (optional)', _endDate, (d) => setState(() => _endDate = d), clearable: true, onClear: () => setState(() => _endDate = null)),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(controller: _description, label: 'Description (invoice line)', prefixIcon: Icons.notes_outlined),
              if (_isEdit) ...[
                const SizedBox(height: AppSpacing.md12),
                const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Status', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
                DropdownButtonFormField<String>(
                  value: _status == 'Paused' ? 'Paused' : 'Active',
                  isExpanded: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.toggle_on_outlined, size: 18)),
                  items: const [DropdownMenuItem(value: 'Active', child: Text('Active')), DropdownMenuItem(value: 'Paused', child: Text('Paused'))],
                  onChanged: (v) => setState(() => _status = v ?? 'Active'),
                ),
              ],
              const SizedBox(height: AppSpacing.lg16),
              FilledButton.icon(
                onPressed: _busy ? null : _save,
                icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.check),
                label: Text(_isEdit ? 'Save Changes' : 'Create Recurring'),
              ),
              const SizedBox(height: AppSpacing.sm8),
            ],
          ),
        ),
      ),
    );
  }

  Widget _dateField(BuildContext context, String label, DateTime? value, ValueChanged<DateTime> onPick, {bool clearable = false, VoidCallback? onClear}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(bottom: AppSpacing.sm8), child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
        InkWell(
          onTap: () async {
            final picked = await showDatePicker(context: context, initialDate: value ?? DateTime.now(), firstDate: DateTime(2015), lastDate: DateTime(2100));
            if (picked != null) onPick(picked);
          },
          child: InputDecorator(
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.event_outlined, size: 18),
              suffixIcon: (clearable && value != null) ? IconButton(icon: const Icon(Icons.clear, size: 16), onPressed: onClear) : null,
            ),
            child: Text(value == null ? 'Select date' : _fmtDate(_ymd(value)), style: TextStyle(color: value == null ? AppColors.text3 : AppColors.text1)),
          ),
        ),
      ],
    );
  }
}

/// Bottom sheet: a template's schedule + the invoices it has generated. Mirrors
/// the web /recurring-invoices/:id/view page.
class _RecurringDetailSheet extends ConsumerWidget {
  const _RecurringDetailSheet({required this.template});
  final Map<String, dynamic> template;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final id = (template['id'] as num?)?.toInt() ?? 0;
    final async = ref.watch(_recDetailProvider(id));
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.92,
      minChildSize: 0.5,
      builder: (_, scroll) => Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.md12),
        child: async.when(
          loading: () => const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator())),
          error: (e, _) => Center(child: Text(e is ApiException ? e.message : 'Could not load.', style: const TextStyle(color: AppColors.danger))),
          data: (d) {
            final t = (d['template'] is Map) ? (d['template'] as Map).cast<String, dynamic>() : template;
            final invoices = (d['invoices'] is List) ? (d['invoices'] as List).whereType<Map>().toList() : const [];
            final gen = t['generated_count'] ?? invoices.length;
            Widget kv(String k, String v) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    Text(k, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                    Flexible(child: Text(v, textAlign: TextAlign.end, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600))),
                  ]),
                );
            return ListView(
              controller: scroll,
              children: [
                Row(children: [
                  Expanded(child: Text('${t['title'] ?? 'Template'}', style: theme.textTheme.titleMedium)),
                  IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
                ]),
                const SizedBox(height: AppSpacing.sm8),
                AppCard(
                  child: Column(children: [
                    kv('Customer', '${t['customer'] ?? '—'}'),
                    kv('Amount', Fmt.inr(t['amount']) + (Fmt.n(t['gst_rate']).toDouble() > 0 ? '  (+${Fmt.n(t['gst_rate'])}% GST)' : '')),
                    kv('Frequency', _cap('${t['frequency'] ?? 'monthly'}')),
                    kv('Next run', _fmtDate(t['next_run_date'])),
                    kv('Generated so far', '$gen'),
                    kv('Start', _fmtDate(t['start_date'])),
                    kv('End', t['end_date'] != null ? _fmtDate(t['end_date']) : 'No end'),
                  ]),
                ),
                const SizedBox(height: AppSpacing.md12),
                Text('Generated Invoices (${invoices.length})', style: theme.textTheme.titleSmall),
                const SizedBox(height: AppSpacing.sm8),
                if (invoices.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('None yet — generated invoices will appear here.', style: TextStyle(color: AppColors.text3))),
                  )
                else
                  for (final inv in invoices)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                      child: AppCard(
                        child: Row(children: [
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text('${inv['invoice_no'] ?? '#${inv['id']}'}', style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
                              Text(_fmtDate(inv['invoice_date']), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                            ]),
                          ),
                          Text(Fmt.inr(inv['total']), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
                        ]),
                      ),
                    ),
                const SizedBox(height: AppSpacing.md12),
              ],
            );
          },
        ),
      ),
    );
  }
}
