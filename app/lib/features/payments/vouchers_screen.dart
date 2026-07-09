import 'dart:async';

import 'package:flutter/material.dart';
import '../../core/module_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart' show invoiceStatusLabel;
import '../../data/models/payment.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';
import 'vouchers_controller.dart';

/// Generic voucher list — drives BOTH Payments and Receipts. Pass the [basePath]
/// (`/payments` | `/receipts`), a [title], the [addRoute] for the + button, and
/// the empty-state copy. Searchable, paginated, pull-to-refresh + infinite scroll.
class VouchersScreen extends ConsumerStatefulWidget {
  const VouchersScreen({
    super.key,
    required this.basePath,
    required this.title,
    required this.addRoute,
    required this.emptyText,
    this.emptyIcon = Icons.receipt_outlined,
  });

  final String basePath;
  final String title;
  final String addRoute;
  final String emptyText;
  final IconData emptyIcon;

  @override
  ConsumerState<VouchersScreen> createState() => _VouchersScreenState();
}

class _VouchersScreenState extends ConsumerState<VouchersScreen> {
  final _searchCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  Timer? _debounce;

  String get _path => widget.basePath;

  @override
  void initState() {
    super.initState();
    _scrollCtl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtl.dispose();
    _scrollCtl.removeListener(_onScroll);
    _scrollCtl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtl.position.pixels >= _scrollCtl.position.maxScrollExtent - 240) {
      ref.read(vouchersControllerProvider(_path).notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(vouchersControllerProvider(_path).notifier).search(q);
    });
  }

  static const _fields = [
    FilterField('status', 'Status', FType.select,
        options: ['pending_tally', 'sent_to_tally', 'created', 'failed'],
        optionLabels: {'pending_tally': 'Pending', 'sent_to_tally': 'Sent', 'created': 'Synced', 'failed': 'Failed'}),
    FilterField('date_from', 'From Date', FType.dateFrom),
    FilterField('date_to', 'To Date', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(vouchersControllerProvider(_path).notifier);
    final res = await showAdvancedFilter(context, ref, title: 'Vouchers filter', fields: _fields, current: ctrl.adv);
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(vouchersControllerProvider(_path));
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    // Permission module is the basePath without the leading slash ('payments' | 'receipts').
    final module = widget.basePath.replaceAll('/', '');
    final canCreate = user?.can(module, 'create') ?? false;
    final vctrl = ref.read(vouchersControllerProvider(_path).notifier);
    final hasFilter = vctrl.adv.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          ModuleInfoButton(module),
          IconButton(
            icon: Icon(hasFilter ? Icons.filter_alt : Icons.tune),
            color: hasFilter ? AppColors.primary : null,
            tooltip: 'Filter (date range)',
            onPressed: _openFilter,
          ),
        ],
      ),
      floatingActionButton: !canCreate
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final created = await context.push<bool>(widget.addRoute);
                if (created == true) {
                  ref.read(vouchersControllerProvider(_path).notifier).refresh();
                }
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by voucher no, party, reference…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(VouchersState state) {
    switch (state) {
      case VouchersLoading():
        return const LoadingState(message: 'Loading…');
      case VouchersError(:final message):
        return ErrorState(
          message,
          onRetry: () => ref.read(vouchersControllerProvider(_path).notifier).refresh(),
        );
      case VouchersReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return EmptyState(widget.emptyText, icon: widget.emptyIcon);
        }
        return RefreshIndicator(
          onRefresh: () => ref.read(vouchersControllerProvider(_path).notifier).refresh(),
          child: ListView.separated(
            controller: _scrollCtl,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32,
            ),
            itemCount: items.length + (hasMore ? 1 : 0),
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              if (i >= items.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg16),
                  child: Center(
                    child: loadingMore
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : const SizedBox.shrink(),
                  ),
                );
              }
              final v = items[i];
              return _VoucherCard(
                v,
                onTap: () async {
                  await context.push('${widget.basePath}/${v.id}');
                  if (context.mounted) {
                    ref.read(vouchersControllerProvider(_path).notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
  }
}

class _VoucherCard extends StatelessWidget {
  const _VoucherCard(this.v, {this.onTap});
  final Payment v;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sub = [
      if (v.mode != null) v.mode!,
      Fmt.date(v.paymentDate),
    ].join(' · ');
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(v.party ?? v.voucherNo, style: theme.textTheme.titleMedium),
                const SizedBox(height: 3),
                Text('${v.voucherNo} · $sub', style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(v.amount), style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              if (v.status != null) StatusPill(invoiceStatusLabel(v.status)),
            ],
          ),
        ],
      ),
    );
  }
}
