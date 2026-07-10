import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
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
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canImport = user?.can('bank-reconciliation', 'create') ?? false;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bank Reconciliation'),
        actions: [
          IconButton(
            icon: const Icon(Icons.file_download_outlined),
            tooltip: 'Sample CSV',
            onPressed: () => _sampleCsv(context),
          ),
          if (canImport)
            IconButton(
              icon: const Icon(Icons.file_upload_outlined),
              tooltip: 'Import statement (CSV)',
              onPressed: () => _import(context, ref),
            ),
          const ModuleInfoButton('bank-reconciliation'),
        ],
      ),
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
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.xxl32),
                    child: Center(
                      child: Column(children: [
                        const Icon(Icons.account_balance_outlined, size: 44, color: AppColors.text3),
                        const SizedBox(height: AppSpacing.md12),
                        const Text('No bank transactions yet.\nImport your bank statement (CSV) to get started.',
                            textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)),
                        const SizedBox(height: AppSpacing.lg16),
                        Wrap(spacing: AppSpacing.sm8, runSpacing: AppSpacing.sm8, alignment: WrapAlignment.center, children: [
                          OutlinedButton.icon(
                            onPressed: () => _sampleCsv(context),
                            icon: const Icon(Icons.file_download_outlined, size: 18),
                            label: const Text('Sample CSV'),
                          ),
                          if (canImport)
                            FilledButton.icon(
                              onPressed: () => _import(context, ref),
                              icon: const Icon(Icons.file_upload_outlined, size: 18),
                              label: const Text('Import statement'),
                            ),
                        ]),
                      ]),
                    ),
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

  // ── Sample CSV — the exact format the importer expects. Writes it to a temp
  // file and opens it; if no app can open a CSV, shows the content in a dialog. ──
  static const _sampleRows = <List<String>>[
    ['Date', 'Description', 'Reference', 'Amount'],
    ['05/07/2026', 'Payment received from Acme Traders', 'NEFT-889021', '15000.00'],
    ['06/07/2026', 'Cheque paid to Global Supplies', 'CHQ-100234', '-8500.00'],
    ['07/07/2026', 'UPI collection - retail', 'UPI-556677', '4200.00'],
    ['08/07/2026', 'Bank charges', '', '-118.00'],
    ['09/07/2026', 'Refund to customer', 'IMPS-771200', '-2500.00'],
  ];

  String _sampleCsvText() => _sampleRows.map((r) => r.map((v) {
        return RegExp(r'[",\n]').hasMatch(v) ? '"${v.replaceAll('"', '""')}"' : v;
      }).join(',')).join('\r\n');

  Future<void> _sampleCsv(BuildContext context) async {
    final csv = _sampleCsvText();
    try {
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/sample-bank-statement.csv';
      await File(path).writeAsString('﻿$csv');
      final res = await OpenFilex.open(path, type: 'text/csv');
      if (res.type == ResultType.done) return;
    } catch (_) {/* fall through to the dialog */}
    if (!context.mounted) return;
    // Fallback — show the format so they can copy it manually.
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sample CSV format'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Save this as a .csv and fill in your rows:',
                style: TextStyle(color: AppColors.text2, fontSize: 13)),
            const SizedBox(height: AppSpacing.sm8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.sm8),
              decoration: BoxDecoration(color: AppColors.scaffoldBg, borderRadius: BorderRadius.circular(AppRadius.sm8)),
              child: SelectableText(csv, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            ),
          ]),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: csv));
              if (ctx.mounted) Navigator.pop(ctx);
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied.')));
              }
            },
            child: const Text('Copy'),
          ),
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close')),
        ],
      ),
    );
  }

  // ── CSV import — pick a .csv, parse it in-app (mirrors the web parser),
  // preview, then POST { rows } to /bank/import (same endpoint the web uses). ──
  Future<void> _import(BuildContext context, WidgetRef ref) async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(
        type: FileType.custom, allowedExtensions: ['csv'], withData: true);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open the file picker: $e')));
      }
      return;
    }
    if (picked == null || picked.files.isEmpty) return;
    final f = picked.files.first;
    final bytes = f.bytes;
    if (bytes == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not read the file.')));
      }
      return;
    }
    String text;
    try {
      text = utf8.decode(bytes, allowMalformed: true);
    } catch (_) {
      text = String.fromCharCodes(bytes);
    }
    final rows = _parseBankCsv(text);
    if (rows.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('No transactions found. Need a header row with Date, Description and Amount (or Debit/Credit).')));
      }
      return;
    }
    if (!context.mounted) return;
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ImportPreviewSheet(fileName: f.name, rows: rows),
    );
    if (confirmed != true) return;
    try {
      await ref.read(apiClientProvider).post('/bank/import', body: {'rows': rows});
      ref.invalidate(_bankProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Imported ${rows.length} transactions.')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Import failed: $e')));
      }
    }
  }
}

// ── CSV parsing (mirrors web/views/bank-reconciliation/index.ejs bkParse) ──
List<Map<String, dynamic>> _parseBankCsv(String content) {
  final lines = content.split(RegExp(r'\r?\n')).where((l) => l.trim().isNotEmpty).toList();
  if (lines.length < 2) return [];
  final head = _splitCsvLine(lines.first).map((h) => h.toLowerCase().trim()).toList();
  int col(List<String> names) {
    for (final n in names) {
      final i = head.indexOf(n);
      if (i != -1) return i;
    }
    return -1;
  }
  final iDate = col(['date', 'txn date', 'transaction date', 'value date']);
  final iDesc = col(['description', 'narration', 'particulars', 'details']);
  final iRef = col(['reference', 'ref', 'chq no', 'cheque no']);
  final iAmt = col(['amount']);
  final iDeb = col(['debit', 'withdrawal', 'dr']);
  final iCr = col(['credit', 'deposit', 'cr']);
  final rows = <Map<String, dynamic>>[];
  for (var r = 1; r < lines.length; r++) {
    final c = _splitCsvLine(lines[r]);
    String at(int i) => (i >= 0 && i < c.length) ? c[i] : '';
    double amount;
    if (iAmt != -1) {
      amount = _csvNum(at(iAmt));
    } else {
      amount = _csvNum(iCr != -1 ? at(iCr) : '') - _csvNum(iDeb != -1 ? at(iDeb) : '');
    }
    if (amount == 0) continue;
    rows.add({
      'txn_date': iDate != -1 ? _toYmd(at(iDate)) : '',
      'description': iDesc != -1 ? at(iDesc) : '',
      'reference': iRef != -1 ? at(iRef) : '',
      'amount': amount,
    });
  }
  return rows;
}

List<String> _splitCsvLine(String line) {
  final out = <String>[];
  final sb = StringBuffer();
  var q = false;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (ch == '"') {
      if (q && i + 1 < line.length && line[i + 1] == '"') {
        sb.write('"');
        i++;
      } else {
        q = !q;
      }
    } else if (ch == ',' && !q) {
      out.add(sb.toString());
      sb.clear();
    } else {
      sb.write(ch);
    }
  }
  out.add(sb.toString());
  return out.map((s) => s.trim()).toList();
}

String _toYmd(String s) {
  s = s.trim();
  if (RegExp(r'^\d{4}-\d{2}-\d{2}').hasMatch(s)) return s.substring(0, 10);
  final m = RegExp(r'^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})').firstMatch(s);
  if (m != null) {
    final d = m.group(1)!.padLeft(2, '0');
    final mo = m.group(2)!.padLeft(2, '0');
    var y = m.group(3)!;
    if (y.length == 2) y = '20$y';
    return '$y-$mo-$d';
  }
  return '';
}

double _csvNum(String s) => double.tryParse(s.replaceAll(RegExp(r'[^0-9.\-]'), '')) ?? 0;

// Bottom-sheet preview of the parsed rows before committing the import.
class _ImportPreviewSheet extends StatelessWidget {
  const _ImportPreviewSheet({required this.fileName, required this.rows});
  final String fileName;
  final List<Map<String, dynamic>> rows;

  @override
  Widget build(BuildContext context) {
    final preview = rows.take(8).toList();
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Import "$fileName"',
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: 4),
          Text('Found ${rows.length} transactions', style: const TextStyle(color: AppColors.text3)),
          const SizedBox(height: AppSpacing.sm8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 300),
            child: ListView(
              shrinkWrap: true,
              children: preview.map((x) {
                final amt = Fmt.n(x['amount']);
                final credit = amt >= 0;
                final desc = '${x['description'] ?? ''}'.isEmpty ? '—' : '${x['description']}';
                final date = '${x['txn_date'] ?? ''}'.isEmpty ? '—' : '${x['txn_date']}';
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(desc, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(date, style: const TextStyle(color: AppColors.text3)),
                  trailing: Text('${credit ? '+' : ''}${Fmt.inr(amt)}',
                      style: TextStyle(fontWeight: FontWeight.w700, color: credit ? _kGreen : _kRed)),
                );
              }).toList(),
            ),
          ),
          if (rows.length > preview.length)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('…and ${rows.length - preview.length} more',
                  style: const TextStyle(color: AppColors.text3, fontSize: 12)),
            ),
          const SizedBox(height: AppSpacing.md12),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel'))),
            const SizedBox(width: AppSpacing.sm8),
            Expanded(
              child: FilledButton.icon(
                onPressed: () => Navigator.pop(context, true),
                icon: const Icon(Icons.file_upload_outlined, size: 18),
                label: Text('Import ${rows.length}'),
              ),
            ),
          ]),
        ],
      ),
    );
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
