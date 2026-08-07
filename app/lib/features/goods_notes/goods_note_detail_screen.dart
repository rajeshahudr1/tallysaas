import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../data/models/goods_note.dart';
import '../../data/repositories/goods_note_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/pdf_action_button.dart';
import '../../shared/widgets/voucher_detail_parts.dart';

/// One delivery / receipt note: header summary, every line item, the tax
/// breakup, and the actions — PDF, Edit, Convert to its invoice, Delete.
class GoodsNoteDetailScreen extends ConsumerStatefulWidget {
  const GoodsNoteDetailScreen({super.key, required this.kind, required this.noteId});
  final GoodsNoteKind kind;
  final int noteId;

  @override
  ConsumerState<GoodsNoteDetailScreen> createState() => _GoodsNoteDetailScreenState();
}

class _GoodsNoteDetailScreenState extends ConsumerState<GoodsNoteDetailScreen> {
  GoodsNote? _note;
  String? _error;
  bool _busy = false;

  GoodsNoteKind get _kind => widget.kind;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final n = await ref.read(goodsNoteRepositoryProvider(_kind)).get(widget.noteId);
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

  Future<void> _convert() async {
    final n = _note;
    if (n == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Convert to ${_kind.invoiceLabel.toLowerCase()}?',
      message: 'A ${_kind.invoiceLabel.toLowerCase()} will be created from '
          '${n.noteNo} with the same party and line items.',
      confirmLabel: 'Convert',
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      final res = await ref.read(goodsNoteRepositoryProvider(_kind)).convert(n.id);
      final raw = (res is Map) ? res['invoice_id'] ?? res['id'] : null;
      if (!mounted) return;
      _snack('${_kind.invoiceLabel} created from ${n.noteNo}.');
      await _load();
      final id = raw is num ? raw.toInt() : int.tryParse(raw?.toString() ?? '');
      if (id != null && mounted) context.push('${_kind.invoicePath}/$id');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not convert this ${_kind.singular.toLowerCase()}.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final n = _note;
    if (n == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete ${_kind.singular.toLowerCase()}?',
      message: '${n.noteNo} will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      await ref.read(goodsNoteRepositoryProvider(_kind)).delete(n.id);
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
        title: Text(n?.noteNo ?? _kind.singular),
        actions: [
          if (n != null)
            PdfActionButton(
              path: '${_kind.path}/${n.id}/pdf',
              name: '${_kind.singular.replaceAll(' ', '')}-${n.noteNo}',
            ),
          // Once invoiced the note is history — no more edits.
          if (n != null && canEdit && !n.isConverted)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('${_kind.path}/${n.id}/edit');
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
      bottomNavigationBar: (n == null || !canEdit || n.isConverted)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg16),
                child: FilledButton.icon(
                  onPressed: _busy ? null : _convert,
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: Text('Convert to ${_kind.invoiceLabel}'),
                ),
              ),
            ),
    );
  }

  Widget _body(GoodsNote? n) {
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
            title: n.party ?? n.noteNo,
            amount: n.total ?? 0,
            statusLabel: goodsNoteStatusLabel(n.noteStatus),
            subtitle:
                '${_kind.movementDateLabel}: ${voucherDate(n.movementDate) ?? '—'}',
          ),
          const DetailSection('Details'),
          AppCard(
            child: Column(
              children: [
                DetailRow(_kind.partyLabel, n.party),
                DetailRow('Note No', n.noteNo),
                DetailRow('Date', voucherDate(n.noteDate)),
                DetailRow(_kind.movementDateLabel, voucherDate(n.movementDate)),
                DetailRow(
                  _kind.orderLabel,
                  n.orderId == null ? null : '#${n.orderId}',
                ),
                DetailRow('Ledger Type', n.ledgerName),
                DetailRow('Location', n.location),
                DetailRow('Sync Status', n.status),
                DetailRow(
                  'Converted ${_kind.invoiceLabel}',
                  n.convertedInvoiceId == null ? null : '#${n.convertedInvoiceId}',
                ),
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
