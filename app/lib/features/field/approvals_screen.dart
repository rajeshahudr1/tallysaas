import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart';
import '../../data/models/paged.dart';
import '../../data/repositories/invoice_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — Invoice Approvals (admin). Lists salesman invoices in
/// approval_status='pending' with Approve / Reject. Approve → real invoice +
/// Tally-eligible. Reject → needs a reason (shown back to the salesman).
class ApprovalsScreen extends ConsumerStatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  ConsumerState<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends ConsumerState<ApprovalsScreen> {
  late Future<PagedResult<Invoice>> _future;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<PagedResult<Invoice>> _load() => ref
      .read(invoiceRepositoryProvider)
      .listSales(perPage: 100, filters: const {'approval': 'pending'});

  void _reload() => setState(() => _future = _load());

  Future<void> _act(Future<void> Function() action, String okMsg) async {
    if (_busy) return;
    setState(() => _busy = true);
    String msg = okMsg;
    bool ok = true;
    try {
      await action();
    } on ApiException catch (e) {
      msg = e.message;
      ok = false;
    } catch (_) {
      msg = 'Something went wrong. Please try again.';
      ok = false;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), backgroundColor: ok ? null : AppColors.danger));
    _reload();
  }

  Future<void> _confirmApprove(Invoice inv) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Approve invoice?'),
        content: Text('${inv.invoiceNo} will count as a real invoice and become eligible for Tally sync.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Approve')),
        ],
      ),
    );
    if (yes == true) {
      _act(() => ref.read(invoiceRepositoryProvider).approve(inv.id), 'Invoice approved.');
    }
  }

  Future<void> _promptReject(Invoice inv) async {
    final ctrl = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Reject ${inv.invoiceNo}'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(
            labelText: 'Reason (shown to the salesman)',
            hintText: 'e.g. Price mismatch — re-check the rate.',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(c, ctrl.text.trim()),
            child: const Text('Reject'),
          ),
        ],
      ),
    );
    if (reason != null && reason.isNotEmpty) {
      _act(() => ref.read(invoiceRepositoryProvider).reject(inv.id, reason), 'Invoice rejected.');
    } else if (reason != null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('A reason is required to reject.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Invoice Approvals')),
      body: FutureBuilder<PagedResult<Invoice>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
            return const LoadingState(message: 'Loading pending approvals…');
          }
          if (snap.hasError && !snap.hasData) {
            return ErrorState('Could not load approvals.', onRetry: _reload);
          }
          final rows = snap.data!.items;
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: rows.isEmpty
                ? ListView(children: const [
                    SizedBox(height: 120),
                    Icon(Icons.verified, size: 48, color: AppColors.success),
                    SizedBox(height: 12),
                    Center(child: Text('All caught up — nothing to approve.',
                        style: TextStyle(color: AppColors.text3))),
                  ])
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(
                        AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
                    itemCount: rows.length,
                    itemBuilder: (context, i) => _row(rows[i]),
                  ),
          );
        },
      ),
    );
  }

  Widget _row(Invoice inv) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
    child: AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(inv.invoiceNo,
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
            ),
            Text(Fmt.inr(inv.total),
                style: const TextStyle(fontWeight: FontWeight.w800, color: AppColors.text1)),
          ]),
          const SizedBox(height: 4),
          Text(inv.customer ?? '—',
              style: const TextStyle(fontSize: 13, color: AppColors.text2)),
          const SizedBox(height: 2),
          Wrap(spacing: 12, children: [
            if (inv.salesPerson != null)
              _meta(Icons.person, inv.salesPerson!),
            if (inv.location != null) _meta(Icons.place, inv.location!),
            if (inv.invoiceDate != null) _meta(Icons.event, Fmt.date(inv.invoiceDate)),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _busy ? null : () => _promptReject(inv),
                icon: const Icon(Icons.close, size: 16),
                label: const Text('Reject'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.danger,
                  side: const BorderSide(color: AppColors.danger),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: FilledButton.icon(
                onPressed: _busy ? null : () => _confirmApprove(inv),
                icon: const Icon(Icons.check, size: 16),
                label: const Text('Approve'),
                style: FilledButton.styleFrom(backgroundColor: AppColors.success),
              ),
            ),
          ]),
        ]),
      ),
    );

  Widget _meta(IconData icon, String text) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 13, color: AppColors.text3),
        const SizedBox(width: 3),
        Text(text, style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
      ]);
}
