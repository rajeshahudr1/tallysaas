import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../data/models/sales_order.dart';
import '../../data/repositories/sales_order_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/pdf_action_button.dart';
import '../../shared/widgets/voucher_detail_parts.dart';

/// One sales order: header summary, every line item, the tax breakup, and the
/// actions — PDF, Edit, Convert to invoice, Delete. Carries every column the
/// web's wide table shows.
class SalesOrderDetailScreen extends ConsumerStatefulWidget {
  const SalesOrderDetailScreen({super.key, required this.orderId});
  final int orderId;

  @override
  ConsumerState<SalesOrderDetailScreen> createState() => _SalesOrderDetailScreenState();
}

class _SalesOrderDetailScreenState extends ConsumerState<SalesOrderDetailScreen> {
  SalesOrder? _so;
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
      final so = await ref.read(salesOrderRepositoryProvider).get(widget.orderId);
      if (mounted) setState(() => _so = so);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this sales order.');
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _convert() async {
    final so = _so;
    if (so == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Convert to invoice?',
      message: 'A sales invoice will be created from ${so.orderNo} with the '
          'same customer and line items.',
      confirmLabel: 'Convert',
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      final res = await ref.read(salesOrderRepositoryProvider).convert(so.id);
      final raw = (res is Map) ? res['invoice_id'] ?? res['id'] : null;
      if (!mounted) return;
      _snack('Invoice created from ${so.orderNo}.');
      await _load();
      final id = raw is num ? raw.toInt() : int.tryParse(raw?.toString() ?? '');
      if (id != null && mounted) context.push('/sales-invoices/$id');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not convert this sales order.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final so = _so;
    if (so == null || _busy) return;
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete sales order?',
      message: '${so.orderNo} will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (ok != true) return;

    setState(() => _busy = true);
    try {
      await ref.read(salesOrderRepositoryProvider).delete(so.id);
      if (mounted) context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not delete this sales order.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can('sales-orders', 'edit') ?? false;
    final canDelete = user?.can('sales-orders', 'delete') ?? false;
    final so = _so;

    return Scaffold(
      appBar: AppBar(
        title: Text(so?.orderNo ?? 'Sales Order'),
        actions: [
          if (so != null)
            PdfActionButton(
              path: '/sales-orders/${so.id}/pdf',
              name: 'SalesOrder-${so.orderNo}',
            ),
          // Once converted the order is history — no more edits.
          if (so != null && canEdit && !so.isConverted)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('/sales-orders/${so.id}/edit');
                if (saved == true) _load();
              },
            ),
          if (so != null && canDelete)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _busy ? null : _delete,
            ),
        ],
      ),
      body: _body(so),
      bottomNavigationBar: (so == null || !canEdit || so.isConverted)
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

  Widget _body(SalesOrder? so) {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    if (so == null) return const LoadingState(message: 'Loading sales order…');

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: [
          VoucherSummaryHeader(
            title: so.customer ?? so.orderNo,
            amount: so.total ?? 0,
            statusLabel: orderStatusLabel(so.orderStatus),
            subtitle: 'Due ${voucherDate(so.dueOn) ?? '—'}',
          ),
          const DetailSection('Details'),
          AppCard(
            child: Column(
              children: [
                DetailRow('Customer', so.customer),
                DetailRow('Order No', so.orderNo),
                DetailRow('Date', voucherDate(so.orderDate)),
                DetailRow('Due On', voucherDate(so.dueOn)),
                DetailRow('Ledger Type', so.ledgerName),
                DetailRow('Location', so.location),
                DetailRow('Sync Status', so.status),
                DetailRow(
                  'Converted Invoice',
                  so.convertedInvoiceId == null ? null : '#${so.convertedInvoiceId}',
                ),
                DetailRow('Notes', so.notes),
              ],
            ),
          ),
          DetailSection('Items (${so.items.length})'),
          for (final it in so.items) ...[
            VoucherItemCard(it),
            const SizedBox(height: AppSpacing.sm8),
          ],
          const DetailSection('Totals'),
          VoucherTotalsCard(
            subtotal: so.subtotal,
            discount: so.discount,
            taxable: so.taxable,
            cgst: so.cgst,
            sgst: so.sgst,
            igst: so.igst,
            roundOff: so.roundOff,
            total: so.total,
          ),
        ],
      ),
    );
  }
}
