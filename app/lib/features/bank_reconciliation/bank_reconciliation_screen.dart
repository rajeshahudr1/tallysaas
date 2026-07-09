import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Bank Reconciliation (app) — view imported statement lines, see auto-match
/// status, and manually match / unmatch / ignore. CSV import is web-only.
final _bankProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/bank/transactions');
  return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
});

const _kGreen = Color(0xFF16A34A);
const _kRed = Color(0xFFDC2626);
const _kAmber = Color(0xFFB45309);

String _fmtDate(dynamic d) {
  final s = d == null ? '' : '$d';
  if (s.length < 10) return s.isEmpty ? '—' : s;
  return s.substring(0, 10).split('-').reversed.join('/');
}

class BankReconciliationScreen extends ConsumerWidget {
  const BankReconciliationScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_bankProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bank Reconciliation'), actions: const [ModuleInfoButton('bank-reconciliation')]),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load.',
          onRetry: () => ref.invalidate(_bankProvider),
        ),
        data: (d) {
          final list = (d['data'] as List?)?.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() ?? const [];
          final s = (d['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_bankProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              children: [
                _summary(context, s),
                const SizedBox(height: AppSpacing.md12),
                if (list.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: AppSpacing.xxl32),
                    child: Center(child: Text('No bank transactions.\nImport a statement (CSV) on the web.',
                        textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3))),
                  )
                else
                  ...list.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _BankCard(r,
                            onMatch: () => _match(context, ref, r),
                            onAction: (a) => _action(context, ref, r, a)),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _summary(BuildContext context, Map<String, dynamic> s) {
    final t = Theme.of(context);
    Widget m(String label, String val, Color c) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: t.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
            const SizedBox(height: 2),
            Text(val, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: c)),
          ]),
        );
    return AppCard(
      child: Column(children: [
        Row(children: [
          m('Matched', '${s['matched'] ?? 0}', _kGreen),
          m('Unmatched', '${s['unmatched'] ?? 0}', _kAmber),
          m('Total', '${s['total'] ?? 0}', AppColors.text1),
        ]),
        const Divider(height: 20),
        Row(children: [
          m('Credits (in)', Fmt.inr(s['credit']), _kGreen),
          m('Debits (out)', Fmt.inr(s['debit']), _kRed),
        ]),
      ]),
    );
  }

  Future<void> _match(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    List<Map<String, dynamic>> cands = [];
    try {
      final res = await ref.read(apiClientProvider).get('/bank/transactions/${r['id']}/candidates');
      cands = (res is Map ? (res['data'] as List?) : null)?.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() ?? [];
    } catch (_) {}
    if (!context.mounted) return;
    final picked = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Match to a voucher', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
            const SizedBox(height: AppSpacing.sm8),
            if (cands.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Text('No matching vouchers found.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)))
            else
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 360),
                child: ListView(
                  shrinkWrap: true,
                  children: cands
                      .map((c) => ListTile(
                            dense: true,
                            title: Text('${c['voucher_no'] ?? '—'} · ${Fmt.inr(c['amount'])}'),
                            subtitle: Text('${c['party'] ?? ''}  ${_fmtDate(c['payment_date'])}', maxLines: 1, overflow: TextOverflow.ellipsis),
                            trailing: const Icon(Icons.link, size: 18, color: AppColors.primary),
                            onTap: () => Navigator.pop(context, (c['id'] as num).toInt()),
                          ))
                      .toList(),
                ),
              ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ),
      ),
    );
    if (picked == null) return;
    try {
      await ref.read(apiClientProvider).post('/bank/transactions/${r['id']}/match', body: {'payment_id': picked});
      ref.invalidate(_bankProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Matched.')));
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not match.')));
    }
  }

  Future<void> _action(BuildContext context, WidgetRef ref, Map<String, dynamic> r, String action) async {
    try {
      if (action == 'delete') {
        await ref.read(apiClientProvider).delete('/bank/transactions/${r['id']}');
      } else {
        await ref.read(apiClientProvider).post('/bank/transactions/${r['id']}/$action', body: {});
      }
      ref.invalidate(_bankProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${action[0].toUpperCase()}${action.substring(1)} done.')));
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Failed.')));
    }
  }
}

class _BankCard extends StatelessWidget {
  const _BankCard(this.r, {required this.onMatch, required this.onAction});
  final Map<String, dynamic> r;
  final VoidCallback onMatch;
  final void Function(String action) onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final amount = Fmt.n(r['amount']);
    final credit = amount >= 0;
    final status = '${r['status'] ?? 'unmatched'}';
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
                    Text('${r['description'] ?? '—'}', maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall),
                    const SizedBox(height: 2),
                    Text('${_fmtDate(r['txn_date'])}${(r['reference'] ?? '').toString().isNotEmpty ? '  ·  ${r['reference']}' : ''}',
                        style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                  ],
                ),
              ),
              Text('${credit ? '+' : ''}${Fmt.inr(amount)}', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: credit ? _kGreen : _kRed)),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          Row(children: [
            _statusPill(status, r['matched_voucher']),
            const Spacer(),
            if (status == 'matched')
              _btn('Unmatch', Icons.link_off, () => onAction('unmatch'))
            else ...[
              _btn('Match', Icons.link, onMatch, primary: true),
              if (status != 'ignored') _btn('Ignore', Icons.block, () => onAction('ignore')),
            ],
          ]),
        ],
      ),
    );
  }

  Widget _statusPill(String status, dynamic voucher) {
    Color c;
    String label;
    if (status == 'matched') { c = _kGreen; label = voucher != null ? '$voucher' : 'Matched'; }
    else if (status == 'ignored') { c = AppColors.text3; label = 'Ignored'; }
    else { c = _kAmber; label = 'Unmatched'; }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c)),
    );
  }

  Widget _btn(String label, IconData icon, VoidCallback onTap, {bool primary = false}) => Padding(
        padding: const EdgeInsets.only(left: 4),
        child: TextButton.icon(
          onPressed: onTap,
          icon: Icon(icon, size: 16),
          label: Text(label),
          style: TextButton.styleFrom(foregroundColor: primary ? AppColors.primary : AppColors.text2, visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)),
        ),
      );
}
