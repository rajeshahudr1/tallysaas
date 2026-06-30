import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/customer.dart';
import '../../data/repositories/customer_repository.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Customer detail (View) — read-only mirror of the form, grouped into the same
/// sections. Edit + Delete in the app bar are gated by the role's permissions
/// (`customers.edit` / `customers.delete`), exactly like the web's row actions.
/// Pops `true` after a delete so the list refreshes.
class CustomerDetailScreen extends ConsumerStatefulWidget {
  const CustomerDetailScreen({super.key, required this.customerId});
  final int customerId;

  @override
  ConsumerState<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends ConsumerState<CustomerDetailScreen> {
  late Future<Customer> _future;
  bool _deleting = false;

  @override
  void initState() {
    super.initState();
    _future = ref.read(customerRepositoryProvider).get(widget.customerId);
  }

  void _reload() {
    setState(() {
      _future = ref.read(customerRepositoryProvider).get(widget.customerId);
    });
  }

  Future<void> _delete() async {
    final ok = await ConfirmDialog.show(
      context,
      title: 'Delete customer?',
      message: 'This customer will be removed. You can re-sync it from Tally later.',
      confirmLabel: 'Delete',
      danger: true,
    );
    if (!ok || _deleting) return;
    setState(() => _deleting = true);
    try {
      await ref.read(customerRepositoryProvider).delete(widget.customerId);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Customer deleted.')));
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
    final canEdit = user?.can('customers', 'edit') ?? false;
    final canDelete = user?.can('customers', 'delete') ?? false;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Customer'),
        actions: [
          if (canEdit)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'Edit',
              onPressed: () async {
                final saved = await context.push<bool>('/customers/${widget.customerId}/edit');
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
      body: FutureBuilder<Customer>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const LoadingState(message: 'Loading customer…');
          }
          if (snap.hasError) {
            final e = snap.error;
            return ErrorState(
              e is ApiException ? e.message : 'Could not load customer.',
              onRetry: _reload,
            );
          }
          return _detail(context, snap.data!);
        },
      ),
    );
  }

  Widget _detail(BuildContext context, Customer c) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      children: [
        // Header
        Row(
          children: [
            Expanded(child: Text(c.name, style: theme.textTheme.headlineSmall)),
            if (c.status != null) StatusPill(c.status!),
          ],
        ),
        const SizedBox(height: AppSpacing.lg16),

        _section('Basic Information'),
        _row('Mobile', c.mobile),
        _row('Alternate Mobile', c.alternateMobile),
        _row('Email', c.email),
        _row('Location', c.location),
        _row('Sales Person', c.salesPerson),
        _row('Tally Ledger', c.isTallyLedger == null ? null : (c.isTallyLedger! ? 'Yes' : 'No')),

        _section('Address'),
        _row('Shipping', c.shippingAddress),
        _row('Billing', c.billingAddress),

        _section('GST & Tax'),
        _row('GST Number', c.gstNumber),
        _row('PAN Number', c.panNumber),

        _section('Other Details'),
        _row('Credit Limit', c.creditLimit == null ? null : Fmt.inr(c.creditLimit)),
        _row('Opening Balance', c.openingBalance == null ? null : Fmt.inr(c.openingBalance)),
        _row('Notes', c.notes),
        _row('Internal Remarks', c.internalRemarks),

        if (c.customFields.isNotEmpty) ...[
          _section('Custom Fields'),
          for (final e in c.customFields.entries)
            _row(e.key, e.value?.toString()),
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

  /// One label/value row — hidden entirely when the value is null/empty so the
  /// detail shows only what's actually set (no rows of dashes).
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
