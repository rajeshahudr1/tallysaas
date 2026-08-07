import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../data/models/return_note.dart';
import '../../data/repositories/return_note_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/pdf_action_button.dart';
import '../../shared/widgets/voucher_detail_parts.dart';

/// One credit / debit note: header summary, every line item, the tax breakup,
/// and the actions — PDF, Edit, Delete.
class ReturnNoteDetailScreen extends ConsumerStatefulWidget {
  const ReturnNoteDetailScreen({super.key, required this.kind, required this.noteId});
  final ReturnNoteKind kind;
  final int noteId;

  @override
  ConsumerState<ReturnNoteDetailScreen> createState() => _ReturnNoteDetailScreenState();
}

class _ReturnNoteDetailScreenState extends ConsumerState<ReturnNoteDetailScreen> {
  ReturnNote? _note;
  String? _error;
  bool _busy = false;

  ReturnNoteKind get _kind => widget.kind;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final n = await ref
          .read(returnNoteRepositoryProvider(_kind))
          .get(widget.noteId);
      if (mounted) setState(() => _note = n);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not load this ${_kind.singular.toLowerCase()}.');
      }
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _delete() async {
    final n = _note;
    if (n == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete ${_kind.singular.toLowerCase()}?',
      message: '${n.invoiceNo} will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      await ref.read(returnNoteRepositoryProvider(_kind)).delete(n.id);
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not delete this ${_kind.singular.toLowerCase()}.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can(_kind.slug, 'edit') ?? false;
    final canDelete = user?.can(_kind.slug, 'delete') ?? false;
    final n = _note;

    return Scaffold(
      appBar: AppBar(
        title: Text(n?.invoiceNo ?? _kind.singular),
        actions: [
          if (n != null)
            PdfActionButton(
              path: '/${_kind.slug}/${n.id}/pdf',
              name: '${_kind.singular.replaceAll(' ', '')}-${n.invoiceNo}',
            ),
          if (n != null && canEdit)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('/${_kind.slug}/${n.id}/edit');
                if (saved == true) _load();
              },
            ),
          if (n != null && canDelete)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _busy ? null : _delete,
            ),
        ],
      ),
      body: _body(n),
    );
  }

  Widget _body(ReturnNote? n) {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    if (n == null) {
      return LoadingState(message: 'Loading ${_kind.singular.toLowerCase()}…');
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: [
          VoucherSummaryHeader(
            title: n.party(_kind) ?? n.invoiceNo,
            amount: n.total ?? 0,
            statusLabel: n.status ?? 'Draft',
            subtitle: voucherDate(n.invoiceDate),
          ),
          const DetailSection('Details'),
          AppCard(
            child: Column(
              children: [
                DetailRow(_kind.partyLabel, n.party(_kind)),
                DetailRow('Note No', n.invoiceNo),
                DetailRow('Date', voucherDate(n.invoiceDate)),
                DetailRow(
                  'Against Invoice',
                  n.againstInvoiceId == null ? null : '#${n.againstInvoiceId}',
                ),
                // Debit notes carry the supplier's own bill reference.
                if (!_kind.isCredit)
                  DetailRow('Supplier Bill No', n.supplierBillNo),
                DetailRow('Location', n.location),
                DetailRow('Sync Status', n.status),
                DetailRow('Notes', n.notes),
              ],
            ),
          ),
          DetailSection('Items (${n.items.length})'),
          for (final it in n.items) ...[
            VoucherItemCard(it),
            const SizedBox(height: AppSpacing.sm8),
          ],
          const DetailSection('Totals'),
          VoucherTotalsCard(
            subtotal: n.subtotal,
            discount: n.discount,
            taxable: n.taxable,
            cgst: n.cgst,
            sgst: n.sgst,
            igst: n.igst,
            roundOff: n.roundOff,
            total: n.total,
          ),
        ],
      ),
    );
  }
}
