import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/paged.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/module_list_scaffold.dart';
import '../../shared/widgets/status_pill.dart';

/// One row of `GET /my/vouchers` — the API unions every voucher family the
/// signed-in user created into a single 8-column shape.
class MyVoucher {
  const MyVoucher({
    required this.id,
    required this.kind,
    this.label,
    this.voucherNo,
    this.date,
    this.party,
    this.amount,
    this.status,
    this.modifiedAt,
  });

  final int id;

  /// Machine kind: quotation | sales_order | purchase_order | delivery_note |
  /// receipt_note | journal | invoice families…
  final String kind;

  /// Human label the API supplies per row ('Quotation', 'Sales Invoice', …).
  final String? label;

  final String? voucherNo;
  final String? date;
  final String? party;
  final num? amount;
  final String? status;

  /// When the entry last changed — what tells you whether a stuck voucher has
  /// moved at all since it was raised.
  final String? modifiedAt;

  /// Where this row opens. Kinds whose screen the app has are pushed; the rest
  /// simply don't navigate rather than guessing a route that 404s.
  String? get route {
    switch (kind) {
      case 'quotation':
        return '/quotations/$id';
      case 'sales_order':
        return '/sales-orders/$id';
      case 'purchase_order':
        return '/purchase-orders/$id';
      case 'delivery_note':
        return '/delivery-notes/$id';
      case 'receipt_note':
        return '/receipt-notes/$id';
      case 'journal':
        return '/journals/$id';
      case 'sales_invoice':
      case 'sales':
        return '/sales-invoices/$id';
      case 'purchase_invoice':
      case 'purchase':
        return '/purchase-invoices/$id';
      case 'receipt':
        return '/receipts/$id';
      case 'payment':
        return '/payments/$id';
      default:
        return null;
    }
  }

  factory MyVoucher.fromJson(Map<String, dynamic> j) => MyVoucher(
        id: _toInt(j['id']) ?? 0,
        kind: (j['kind'] ?? '').toString(),
        label: _sn(j['label']),
        voucherNo: _sn(j['voucher_no']),
        date: _sn(j['date']),
        party: _sn(j['party']),
        amount: _toNum(j['amount']),
        status: _sn(j['status']),
        modifiedAt: _sn(j['modified_at']),
      );
}

/// Paginated fetch of the user's own vouchers across every family.
class _MyVouchersController extends StateNotifier<AsyncValue<List<MyVoucher>>> {
  _MyVouchersController(this._api) : super(const AsyncValue.loading()) {
    _reload();
  }

  final ApiClient _api;
  static const _perPage = 20;

  int _page = 1;
  bool _hasMore = true;
  bool _loadingMore = false;
  final List<MyVoucher> _all = [];

  bool get hasMore => _hasMore;
  bool get loadingMore => _loadingMore;

  Future<void> _reload() async {
    _page = 1;
    _hasMore = true;
    _all.clear();
    if (mounted) state = const AsyncValue.loading();
    await _fetch();
  }

  Future<void> _fetch() async {
    try {
      final data = await _api.get('/my/vouchers',
          query: {'page': _page, 'per_page': _perPage});
      final res = PagedResult<MyVoucher>.fromData(data, MyVoucher.fromJson);
      _all.addAll(res.items);
      _hasMore = res.hasMore;
      _loadingMore = false;
      if (mounted) state = AsyncValue.data(List.unmodifiable(_all));
    } on ApiException catch (e) {
      _loadingMore = false;
      if (mounted) state = AsyncValue.error(e.message, StackTrace.current);
    } catch (_) {
      _loadingMore = false;
      if (mounted) {
        state = AsyncValue.error(
            'Could not load your vouchers. Pull to retry.', StackTrace.current);
      }
    }
  }

  Future<void> refresh() => _reload();

  Future<void> loadMore() async {
    if (!_hasMore || _loadingMore) return;
    _loadingMore = true;
    _page += 1;
    await _fetch();
  }
}

final _myVouchersProvider = StateNotifierProvider.autoDispose<
    _MyVouchersController, AsyncValue<List<MyVoucher>>>((ref) {
  return _MyVouchersController(ref.watch(apiClientProvider));
});

/// My Vouchers — everything the signed-in user created, newest first, across
/// quotations, orders, notes, invoices, receipts, payments and journals.
class MyVouchersScreen extends ConsumerWidget {
  const MyVouchersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(_myVouchersProvider);
    final ctrl = ref.read(_myVouchersProvider.notifier);
    final items = state.valueOrNull ?? const <MyVoucher>[];

    return ModuleListScaffold<MyVoucher>(
      title: 'My Vouchers',
      infoKey: 'my-vouchers',
      emptyMessage: 'You have not created any vouchers yet.',
      emptyIcon: Icons.description_outlined,
      items: items,
      loading: state.isLoading && items.isEmpty,
      error: state.hasError ? '${state.error}' : null,
      hasMore: ctrl.hasMore,
      loadingMore: ctrl.loadingMore,
      // The endpoint unions many tables and offers no search or filters.
      onSearch: (_) {},
      onLoadMore: ctrl.loadMore,
      onRefresh: ctrl.refresh,
      itemBuilder: (context, v) => _VoucherCard(
        v,
        onTap: v.route == null
            ? null
            : () async {
                await context.push(v.route!);
                if (context.mounted) ctrl.refresh();
              },
      ),
    );
  }
}

class _VoucherCard extends StatelessWidget {
  const _VoucherCard(this.v, {this.onTap});
  final MyVoucher v;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = v.date == null ? null : DateTime.tryParse(v.date!);
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(v.voucherNo ?? '—',
                          style: theme.textTheme.titleMedium),
                    ),
                    if (v.label != null)
                      Container(
                        padding:
                            const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppColors.primaryTint,
                          borderRadius: BorderRadius.circular(AppRadius.pill999),
                        ),
                        child: Text(
                          v.label!,
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: AppColors.primary),
                        ),
                      ),
                  ],
                ),
                if (v.party != null) ...[
                  const SizedBox(height: 3),
                  Text(v.party!,
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 2),
                Text(
                  [
                    date == null ? '—' : Fmt.date(date),
                    if (v.modifiedAt != null) 'modified ${Fmt.date(v.modifiedAt)}',
                  ].join('  •  '),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(v.amount ?? 0), style: theme.textTheme.titleSmall),
              if (v.status != null) ...[
                const SizedBox(height: 6),
                StatusPill(v.status!),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

String? _sn(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

int? _toInt(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toInt();
  final s = v.toString().trim();
  return s.isEmpty ? null : int.tryParse(s);
}

num? _toNum(Object? v) {
  if (v == null) return null;
  if (v is num) return v;
  final s = v.toString().trim();
  return s.isEmpty ? null : num.tryParse(s);
}
