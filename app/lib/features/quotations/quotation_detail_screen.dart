import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/quotation.dart';
import '../../data/repositories/quotation_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/pdf_action_button.dart';
import '../../shared/widgets/status_pill.dart';

/// One quotation: header summary, every line item, the tax breakup, and the
/// actions — PDF, Edit, Convert to invoice, Delete. This is where the web's
/// wide-table columns live on mobile; nothing the web shows is dropped.
class QuotationDetailScreen extends ConsumerStatefulWidget {
  const QuotationDetailScreen({super.key, required this.quotationId});
  final int quotationId;

  @override
  ConsumerState<QuotationDetailScreen> createState() => _QuotationDetailScreenState();
}

class _QuotationDetailScreenState extends ConsumerState<QuotationDetailScreen> {
  Quotation? _q;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final q = await ref.read(quotationRepositoryProvider).get(widget.quotationId);
      if (mounted) setState(() => _q = q);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this quotation.');
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Turns an accepted quote into a real sales invoice and opens it.
  Future<void> _convert() async {
    final q = _q;
    if (q == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Convert to invoice?',
      message: 'A sales invoice will be created from ${q.quotationNo} with the '
          'same customer and line items.',
      confirmLabel: 'Convert',
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      final res = await ref.read(quotationRepositoryProvider).convert(q.id);
      final invoiceId = (res is Map) ? res['invoice_id'] ?? res['id'] : null;
      if (!mounted) return;
      _snack('Invoice created from ${q.quotationNo}.');
      await _load();
      final id = invoiceId is num
          ? invoiceId.toInt()
          : int.tryParse(invoiceId?.toString() ?? '');
      if (id != null && mounted) context.push('/sales-invoices/$id');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not convert this quotation.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final q = _q;
    if (q == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete quotation?',
      message: '${q.quotationNo} will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      await ref.read(quotationRepositoryProvider).delete(q.id);
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not delete this quotation.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can('quotations', 'edit') ?? false;
    final canDelete = user?.can('quotations', 'delete') ?? false;
    final q = _q;

    return Scaffold(
      appBar: AppBar(
        title: Text(q?.quotationNo ?? 'Quotation'),
        actions: [
          if (q != null)
            PdfActionButton(
              path: '/quotations/${q.id}/pdf',
              name: 'Quotation-${q.quotationNo}',
            ),
          // Only a DRAFT quote may be edited — once converted it is history.
          if (q != null && canEdit && !q.isConverted)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('/quotations/${q.id}/edit');
                if (saved == true) _load();
              },
            ),
          if (q != null && canDelete)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _busy ? null : _delete,
            ),
        ],
      ),
      body: _body(q),
      bottomNavigationBar: (q == null || !canEdit || q.isConverted)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg16),
                child: FilledButton.icon(
                  onPressed: _busy ? null : _convert,
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const Text('Convert to Sales Invoice'),
                ),
              ),
            ),
    );
  }

  Widget _body(Quotation? q) {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    if (q == null) return const LoadingState(message: 'Loading quotation…');

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: [
          _summary(q),
          const DetailSection('Details'),
          AppCard(
            child: Column(
              children: [
                DetailRow('Customer', q.customer),
                DetailRow('Quotation No', q.quotationNo),
                DetailRow('Date', _date(q.quotationDate)),
                DetailRow('Valid Till', _date(q.validTill)),
                DetailRow('Ledger Type', q.ledgerName),
                DetailRow('Location', q.location),
                DetailRow('Sync Status', q.status),
                DetailRow(
                  'Converted Invoice',
                  q.convertedInvoiceId == null ? null : '#${q.convertedInvoiceId}',
                ),
                DetailRow('Notes', q.notes),
              ],
            ),
          ),
          DetailSection('Items (${q.items.length})'),
          for (final it in q.items) ...[
            _itemCard(it),
            const SizedBox(height: AppSpacing.sm8),
          ],
          const DetailSection('Totals'),
          AppCard(
            child: Column(
              children: [
                _total('Sub Total', q.subtotal),
                _total('Discount', q.discount),
                _total('Taxable', q.taxable),
                if ((q.igst ?? 0) > 0)
                  _total('IGST', q.igst)
                else ...[
                  _total('CGST', q.cgst),
                  _total('SGST', q.sgst),
                ],
                _total('Round Off', q.roundOff),
                const Divider(),
                _total('Grand Total', q.total, strong: true),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _summary(Quotation q) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.lg16),
      decoration: BoxDecoration(
        gradient: AppGradients.header,
        borderRadius: BorderRadius.circular(AppRadius.lg16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(q.customer ?? q.quotationNo,
                    style: theme.textTheme.titleLarge),
              ),
              StatusPill(quoteStatusLabel(q.quoteStatus)),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text(Fmt.inr(q.total ?? 0), style: theme.textTheme.headlineSmall),
          const SizedBox(height: 2),
          Text(
            'Valid till ${_date(q.validTill) ?? '—'}',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  Widget _itemCard(QuotationItem it) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(it.description ?? 'Item',
                    style: theme.textTheme.titleMedium),
              ),
              Text(Fmt.inr(it.amount ?? 0), style: theme.textTheme.titleSmall),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${it.quantity ?? 0} ${it.unit ?? ''} × ${Fmt.inr(it.rate ?? 0)}'
            '${(it.discountPct ?? 0) > 0 ? '  •  ${it.discountPct}% off' : ''}',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 2),
          Text(
            [
              if (it.hsn != null) 'HSN ${it.hsn}',
              'GST ${it.gstRate ?? 0}%',
              if ((it.gstAmount ?? 0) > 0) Fmt.inr(it.gstAmount ?? 0),
              if (it.godown != null) it.godown!,
              if (it.taxInclusive) 'Tax incl.',
            ].join('  •  '),
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  Widget _total(String label, num? value, {bool strong = false}) {
    final theme = Theme.of(context);
    final style = strong
        ? theme.textTheme.titleMedium?.copyWith(color: AppColors.primary)
        : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: strong ? style : theme.textTheme.bodySmall),
          Text(Fmt.inr(value ?? 0), style: style),
        ],
      ),
    );
  }

  String? _date(String? iso) {
    if (iso == null) return null;
    final d = DateTime.tryParse(iso);
    return d == null ? iso : Fmt.date(d);
  }
}
