import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/supplier.dart';
import '../../data/repositories/supplier_repository.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import '../registers/party_activity_screen.dart';
import '../registers/party_items_screen.dart';

/// Supplier detail (View) — read-only mirror of the form. Edit + Delete in the
/// app bar are gated by `suppliers.edit` / `suppliers.delete`, like the web's
/// row actions. Pops `true` after a delete so the list refreshes.
class SupplierDetailScreen extends ConsumerStatefulWidget {
  const SupplierDetailScreen({super.key, required this.supplierId});
  final int supplierId;

  @override
  ConsumerState<SupplierDetailScreen> createState() => _SupplierDetailScreenState();
}

class _SupplierDetailScreenState extends ConsumerState<SupplierDetailScreen> {
  late Future<Supplier> _future;
  bool _deleting = false;

  /// Remembered as the row loads, purely so the Items screen can show a title.
  /// No setState — nothing on THIS screen renders from it.
  String _name = '';

  @override
  void initState() {
    super.initState();
    _future = _fetch();
  }

  Future<Supplier> _fetch() async {
    final s = await ref.read(supplierRepositoryProvider).get(widget.supplierId);
    _name = s.name;
    return s;
  }

  void _reload() {
    setState(() {
      _future = _fetch();
    });
  }

  Future<void> _delete() async {
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete supplier?',
      message: 'This supplier will be removed. You can re-sync it from Tally later.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (!ok || _deleting) return;
    setState(() => _deleting = true);
    try {
      await ref.read(supplierRepositoryProvider).delete(widget.supplierId);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Supplier deleted.')));
      context.pop(true);
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (e) {
      _snack('Could not delete: $e');
    } finally {
      if (mounted) setState(() => _deleting = false);
    }
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can('suppliers', 'edit') ?? false;
    final canDelete = user?.can('suppliers', 'delete') ?? false;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Supplier'),
        actions: [
          // What was SAID, as opposed to what was billed.
          IconButton(
            icon: const Icon(Icons.forum_outlined),
            tooltip: 'Activity',
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => PartyActivityScreen(
                partyId: widget.supplierId,
                partyName: _name,
                supplier: true,
              ),
            )),
          ),
          // What we have bought from this supplier, rolled up per stock item.
          IconButton(
            icon: const Icon(Icons.inventory_2_outlined),
            tooltip: 'Items purchased',
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => PartyItemsScreen(
                partyId: widget.supplierId,
                partyName: _name,
                purchased: true,
              ),
            )),
          ),
          if (canEdit)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('/suppliers/${widget.supplierId}/edit');
                if (saved == true) _reload();
              },
            ),
          if (canDelete)
            IconButton(
              icon: _deleting
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.delete_outline),
              tooltip: 'Delete',
              onPressed: _deleting ? null : _delete,
            ),
        ],
      ),
      body: FutureBuilder<Supplier>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const LoadingState(message: 'Loading supplier…');
          }
          if (snap.hasError) {
            final e = snap.error;
            return ErrorState(
              e is ApiException ? e.message : 'Could not load supplier.',
              onRetry: _reload,
            );
          }
          return _detail(context, snap.data!);
        },
      ),
    );
  }

  Widget _detail(BuildContext context, Supplier s) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      children: [
        Row(
          children: [
            Expanded(child: Text(s.name, style: theme.textTheme.headlineSmall)),
            if (s.status != null) StatusPill(s.status!),
          ],
        ),
        const SizedBox(height: AppSpacing.lg16),

        _section('Basic Information'),
        _row('Mobile', s.mobile),
        _row('Alternate Mobile', s.alternateMobile),
        _row('Supplier Group', s.supplierGroup),
        _row('Email', s.email),
        _row('Location', s.location),
        _row('Tally Ledger', s.isTallyLedger == null ? null : (s.isTallyLedger! ? 'Yes (Sundry Creditor)' : 'No')),

        _section('Address'),
        _row('Address', s.address),

        _section('GST & Tax'),
        _row('GST Number', s.gstNumber),
        _row('PAN Number', s.panNumber),

        _section('Other Details'),
        _row('Opening Balance', s.openingBalance == null ? null : Fmt.inr(s.openingBalance)),
        _row('Payment Terms', s.paymentTerms),
        // Null prints as a dash, not "0 days" — we do not know the terms.
        _row('Credit Days', s.creditDays == null ? null : '${s.creditDays} days'),
        // Where they stand today (synced from Tally), beside where they began.
        _row('Closing Balance', s.closingBalance == null ? null : Fmt.inr(s.closingBalance)),
        _row('Last Purchased', s.lastPurchasedDate == null ? null : Fmt.date(s.lastPurchasedDate)),
        _row('Tally Ledger Group', s.tallyLedgerGroup),

        if (s.customFields.isNotEmpty) ...[
          _section('Custom Fields'),
          for (final e in s.customFields.entries) _row(e.key, e.value?.toString()),
        ],
      ],
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(top: AppSpacing.lg16, bottom: AppSpacing.sm8),
        child: Text(t,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppColors.primary, fontWeight: FontWeight.w700)),
      );

  Widget _row(String label, String? value) {
    if (value == null || value.trim().isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(label, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}
