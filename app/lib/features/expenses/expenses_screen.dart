import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Expenses — a lightweight expense book: record an amount under a category, on
/// a date, paid to a vendor by some mode. List + add/edit sheet + delete +
/// categories manager. Mirrors the web Expenses page.
final _expensesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/expenses', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

final _expenseCategoriesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/expense-categories', query: {'per_page': 100});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

const _kRed = Color(0xFFDC2626);
const _kPurple = Color(0xFF6D28D9);
const _kModes = ['Cash', 'Bank', 'UPI', 'Card', 'Cheque', 'Other'];

String _fmtDate(dynamic d) {
  final s = d == null ? '' : '$d';
  if (s.length < 10) return s.isEmpty ? '—' : s;
  return s.substring(0, 10).split('-').reversed.join('/');
}

class ExpensesScreen extends ConsumerWidget {
  const ExpensesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_expensesProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Expenses'),
        actions: [
          IconButton(
            tooltip: 'Categories',
            icon: const Icon(Icons.sell_outlined),
            onPressed: () => _manageCategories(context, ref),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _addOrEdit(context, ref, null),
        icon: const Icon(Icons.add),
        label: const Text('Add Expense'),
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load expenses.',
          onRetry: () => ref.invalidate(_expensesProvider),
        ),
        data: (list) {
          final now = DateTime.now();
          final monthStart = '${now.year}-${now.month.toString().padLeft(2, '0')}-01';
          num total = 0, monthTotal = 0;
          for (final e in list) {
            final amt = Fmt.n(e['amount']);
            total += amt;
            final d = '${e['expense_date'] ?? ''}';
            if (d.length >= 10 && d.substring(0, 10).compareTo(monthStart) >= 0) monthTotal += amt;
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_expensesProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32 + 40),
              children: [
                _summaryCard(context, monthTotal, total, list.length),
                const SizedBox(height: AppSpacing.md12),
                if (list.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: AppSpacing.xxl32),
                    child: Center(child: Text('No expenses yet.\nTap "Add Expense" to record one.',
                        textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3))),
                  )
                else
                  ...list.map((e) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _ExpenseCard(e,
                            onEdit: () => _addOrEdit(context, ref, e),
                            onDelete: () => _delete(context, ref, e)),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _summaryCard(BuildContext context, num month, num total, int count) {
    final t = Theme.of(context);
    Widget m(String label, String val, Color color) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: t.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
            const SizedBox(height: 2),
            Text(val, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: color)),
          ]),
        );
    return AppCard(
      child: Row(children: [
        m('This Month', Fmt.inr(month), _kRed),
        const SizedBox(width: AppSpacing.sm8),
        m('Total', Fmt.inr(total), AppColors.text1),
        const SizedBox(width: AppSpacing.sm8),
        m('Records', '$count', AppColors.primary),
      ]),
    );
  }

  Future<void> _addOrEdit(BuildContext context, WidgetRef ref, Map<String, dynamic>? existing) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ExpenseSheet(existing: existing),
    );
    if (ok == true) ref.invalidate(_expensesProvider);
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Map<String, dynamic> e) async {
    final yes = await ConfirmDialog.show(context,
        title: 'Delete this expense?', message: 'This action cannot be undone.', confirmLabel: 'Delete', danger: true);
    if (!yes) return;
    try {
      await ref.read(apiClientProvider).delete('/expenses/${e['id']}');
      ref.invalidate(_expensesProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Expense deleted.')));
    } catch (err) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err is ApiException ? err.message : 'Could not delete: $err')));
      }
    }
  }

  Future<void> _manageCategories(BuildContext context, WidgetRef ref) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => const _CategoriesSheet(),
    );
    ref.invalidate(_expenseCategoriesProvider);
  }
}

class _ExpenseCard extends StatelessWidget {
  const _ExpenseCard(this.e, {required this.onEdit, required this.onDelete});
  final Map<String, dynamic> e;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final category = '${e['category'] ?? ''}';
    final vendor = '${e['vendor'] ?? ''}';
    final mode = '${e['payment_mode'] ?? ''}';
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Text(_fmtDate(e['expense_date']), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                  if (category.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(color: _kPurple.withOpacity(0.10), borderRadius: BorderRadius.circular(999)),
                      child: Text(category, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _kPurple)),
                    ),
                  ],
                ]),
                const SizedBox(height: 4),
                Text(vendor.isEmpty ? '(no vendor)' : vendor, style: theme.textTheme.titleMedium),
                if (mode.isNotEmpty) Text(mode, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(e['amount']), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: _kRed)),
              const SizedBox(height: 2),
              Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(icon: const Icon(Icons.edit_outlined, size: 19), color: AppColors.primary, visualDensity: VisualDensity.compact, onPressed: onEdit),
                IconButton(icon: const Icon(Icons.delete_outline, size: 19), color: _kRed, visualDensity: VisualDensity.compact, onPressed: onDelete),
              ]),
            ],
          ),
        ],
      ),
    );
  }
}

/// Add / edit an expense.
class _ExpenseSheet extends ConsumerStatefulWidget {
  const _ExpenseSheet({this.existing});
  final Map<String, dynamic>? existing;
  @override
  ConsumerState<_ExpenseSheet> createState() => _ExpenseSheetState();
}

class _ExpenseSheetState extends ConsumerState<_ExpenseSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _vendor;
  late final TextEditingController _amount;
  late final TextEditingController _reference;
  late final TextEditingController _notes;
  int? _categoryId;
  String? _mode;
  DateTime? _date;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _vendor = TextEditingController(text: '${e?['vendor'] ?? ''}');
    _amount = TextEditingController(text: e?['amount'] != null ? '${e!['amount']}' : '');
    _reference = TextEditingController(text: '${e?['reference'] ?? ''}');
    _notes = TextEditingController(text: '${e?['notes'] ?? ''}');
    _categoryId = (e?['category_id'] as num?)?.toInt();
    final m = '${e?['payment_mode'] ?? ''}';
    _mode = _kModes.contains(m) ? m : null;
    final d = '${e?['expense_date'] ?? ''}';
    if (d.length >= 10) _date = DateTime.tryParse(d.substring(0, 10));
  }

  @override
  void dispose() {
    _vendor.dispose();
    _amount.dispose();
    _reference.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      final body = {
        'category_id': _categoryId,
        'vendor': _vendor.text.trim(),
        'expense_date': _date == null ? null : '${_date!.year}-${_date!.month.toString().padLeft(2, '0')}-${_date!.day.toString().padLeft(2, '0')}',
        'amount': double.tryParse(_amount.text.trim()) ?? 0,
        'payment_mode': _mode,
        'reference': _reference.text.trim(),
        'notes': _notes.text.trim(),
      };
      final api = ref.read(apiClientProvider);
      if (widget.existing != null) {
        await api.put('/expenses/${widget.existing!['id']}', body: body);
      } else {
        await api.post('/expenses', body: body);
      }
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(widget.existing != null ? 'Expense updated.' : 'Expense added.')));
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
    final cats = ref.watch(_expenseCategoriesProvider);
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
                Text(widget.existing != null ? 'Edit Expense' : 'Add Expense',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
                const Spacer(),
                IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
              ]),
              const SizedBox(height: AppSpacing.sm8),
              // Category
              const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Category', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
              cats.maybeWhen(
                data: (list) => DropdownButtonFormField<int?>(
                  value: _categoryId,
                  isExpanded: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.sell_outlined, size: 18)),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('Uncategorized')),
                    ...list.map((c) => DropdownMenuItem<int?>(value: (c['id'] as num).toInt(), child: Text('${c['name'] ?? ''}', overflow: TextOverflow.ellipsis))),
                  ],
                  onChanged: (v) => setState(() => _categoryId = v),
                ),
                orElse: () => DropdownButtonFormField<int?>(
                  value: null,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.sell_outlined, size: 18)),
                  items: const [DropdownMenuItem<int?>(value: null, child: Text('Uncategorized'))],
                  onChanged: null,
                ),
              ),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(controller: _vendor, label: 'Vendor / Paid to', prefixIcon: Icons.store_outlined),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(controller: _amount, label: 'Amount *', keyboardType: const TextInputType.numberWithOptions(decimal: true), prefixIcon: Icons.currency_rupee,
                  validator: (v) => (double.tryParse((v ?? '').trim()) == null) ? 'Enter a valid amount' : null),
              const SizedBox(height: AppSpacing.md12),
              // Date
              const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Date', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
              InkWell(
                onTap: () async {
                  final picked = await showDatePicker(context: context, initialDate: _date ?? DateTime.now(), firstDate: DateTime(2015), lastDate: DateTime(2100));
                  if (picked != null) setState(() => _date = picked);
                },
                child: InputDecorator(
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.event_outlined, size: 18)),
                  child: Text(_date == null ? 'Select date' : _fmtDate('${_date!.year}-${_date!.month.toString().padLeft(2, '0')}-${_date!.day.toString().padLeft(2, '0')}'),
                      style: TextStyle(color: _date == null ? AppColors.text3 : AppColors.text1)),
                ),
              ),
              const SizedBox(height: AppSpacing.md12),
              // Payment mode
              const Padding(padding: EdgeInsets.only(bottom: AppSpacing.sm8), child: Text('Payment Mode', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
              DropdownButtonFormField<String?>(
                value: _mode,
                isExpanded: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.account_balance_wallet_outlined, size: 18)),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('—')),
                  ..._kModes.map((m) => DropdownMenuItem<String?>(value: m, child: Text(m))),
                ],
                onChanged: (v) => setState(() => _mode = v),
              ),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(controller: _reference, label: 'Reference', prefixIcon: Icons.tag_outlined),
              const SizedBox(height: AppSpacing.md12),
              AppTextField(controller: _notes, label: 'Notes', prefixIcon: Icons.notes_outlined),
              const SizedBox(height: AppSpacing.lg16),
              FilledButton.icon(
                onPressed: _busy ? null : _save,
                icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.check),
                label: Text(widget.existing != null ? 'Save Changes' : 'Add Expense'),
              ),
              const SizedBox(height: AppSpacing.sm8),
            ],
          ),
        ),
      ),
    );
  }
}

/// Manage expense categories — add + delete.
class _CategoriesSheet extends ConsumerStatefulWidget {
  const _CategoriesSheet();
  @override
  ConsumerState<_CategoriesSheet> createState() => _CategoriesSheetState();
}

class _CategoriesSheetState extends ConsumerState<_CategoriesSheet> {
  final _name = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    final name = _name.text.trim();
    if (name.isEmpty || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/expense-categories', body: {'name': name});
      _name.clear();
      ref.invalidate(_expenseCategoriesProvider);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not add: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _del(Map<String, dynamic> c) async {
    try {
      await ref.read(apiClientProvider).delete('/expense-categories/${c['id']}');
      ref.invalidate(_expenseCategoriesProvider);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not delete: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final cats = ref.watch(_expenseCategoriesProvider);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            const Text('Expense Categories', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
            const Spacer(),
            IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
          ]),
          const SizedBox(height: AppSpacing.sm8),
          Row(children: [
            Expanded(child: AppTextField(controller: _name, hint: 'New category', prefixIcon: Icons.add)),
            const SizedBox(width: AppSpacing.sm8),
            FilledButton(onPressed: _busy ? null : _add, child: const Text('Add')),
          ]),
          const SizedBox(height: AppSpacing.md12),
          cats.maybeWhen(
            data: (list) => list.isEmpty
                ? const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Text('No categories yet.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)))
                : ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 300),
                    child: ListView(
                      shrinkWrap: true,
                      children: list
                          .map((c) => ListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text('${c['name'] ?? ''}'),
                                trailing: IconButton(icon: const Icon(Icons.delete_outline, size: 19, color: _kRed), onPressed: () => _del(c)),
                              ))
                          .toList(),
                    ),
                  ),
            orElse: () => const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Center(child: CircularProgressIndicator())),
          ),
          const SizedBox(height: AppSpacing.sm8),
        ],
      ),
    );
  }
}
