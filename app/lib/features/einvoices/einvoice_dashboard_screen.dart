import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

final _dashboardProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/einvoices/dashboard');
  return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
});

/// e-Invoice Dashboard — today's IRP activity at a glance: what was generated,
/// what failed, what is still pending, e-Way bills expiring today, and the last
/// few documents touched.
class EInvoiceDashboardScreen extends ConsumerWidget {
  const EInvoiceDashboardScreen({super.key});

  static final _stamp = DateFormat('dd MMM, hh:mm a');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_dashboardProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('e-Invoice Dashboard'),
        actions: const [ModuleInfoButton('einvoice')],
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading dashboard…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load the dashboard.',
          onRetry: () async => ref.invalidate(_dashboardProvider),
        ),
        data: (d) {
          final today = (d['today'] is Map)
              ? (d['today'] as Map).cast<String, dynamic>()
              : const <String, dynamic>{};
          final api = (d['api_status'] is Map)
              ? (d['api_status'] as Map).cast<String, dynamic>()
              : const <String, dynamic>{};
          final recent = (d['recent'] is List)
              ? (d['recent'] as List)
                  .whereType<Map>()
                  .map((m) => m.cast<String, dynamic>())
                  .toList()
              : const <Map<String, dynamic>>[];

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_dashboardProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
              ),
              children: [
                Text('Today', style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.sm8),
                Row(
                  children: [
                    _tile(theme, 'Generated', today['generated'], AppColors.success),
                    const SizedBox(width: AppSpacing.sm8),
                    _tile(theme, 'Failed', today['failed'], AppColors.danger),
                    const SizedBox(width: AppSpacing.sm8),
                    _tile(theme, 'Cancelled', today['cancelled'], AppColors.muted),
                  ],
                ),
                const SizedBox(height: AppSpacing.sm8),
                Row(
                  children: [
                    _tile(theme, 'Pending', d['pending'], AppColors.warn),
                    const SizedBox(width: AppSpacing.sm8),
                    // e-Way bills whose validity runs out today — the one number
                    // worth acting on before the day ends.
                    _tile(theme, 'e-Way expiring', d['expiry_today'], AppColors.warn),
                    const SizedBox(width: AppSpacing.sm8),
                    _tile(theme, 'API ok / fail',
                        '${api['ok'] ?? 0}/${api['fail'] ?? 0}', AppColors.primary),
                  ],
                ),

                const DetailSection('Recent activity'),
                if (recent.isEmpty)
                  Text('Nothing has been sent to the IRP yet.',
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: AppColors.text3))
                else
                  for (final r in recent) ...[
                    AppCard(
                      onTap: () => context.push('/einvoices'),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('${r['invoice_no'] ?? '—'}',
                                    style: theme.textTheme.titleMedium),
                                const SizedBox(height: 3),
                                Text(
                                  [
                                    if (r['irn'] != null)
                                      'IRN ${_short('${r['irn']}')}',
                                    if (r['ewb_no'] != null) 'eWay ${r['ewb_no']}',
                                    _fmt(r['at']),
                                  ].join('  •  '),
                                  style: theme.textTheme.bodySmall,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm8),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              StatusPill('${r['irp_status'] ?? 'pending'}'),
                              if (r['ewb_status'] != null) ...[
                                const SizedBox(height: 4),
                                Text('eWay ${r['ewb_status']}',
                                    style: theme.textTheme.labelSmall),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm8),
                  ],
              ],
            ),
          );
        },
      ),
    );
  }

  /// An IRN is 64 characters — show enough to recognise it, not all of it.
  static String _short(String s) => s.length <= 12 ? s : '${s.substring(0, 12)}…';

  static String _fmt(Object? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso.toString());
    return d == null ? iso.toString() : _stamp.format(d.toLocal());
  }

  Widget _tile(ThemeData theme, String label, Object? value, Color color) {
    return Expanded(
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${value ?? 0}',
                style: theme.textTheme.titleLarge?.copyWith(color: color)),
            const SizedBox(height: 2),
            Text(label, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
