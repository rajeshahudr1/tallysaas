import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Notifications — the bell feed (GET /sync/notifications). Mirrors the web's
/// notification dropdown / page: recent create/update/delete activity across
/// every module with a tone-coloured icon, title, subtitle and time. The
/// `unread` count drives the bell badge (see [notificationsUnreadProvider]).
final notificationsProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/sync/notifications');
  return data is Map ? data.cast<String, dynamic>() : <String, dynamic>{};
});

/// Lightweight unread count for the dashboard bell badge — same endpoint, just
/// the `unread` int. Cheap enough to watch from the app bar.
final notificationsUnreadProvider = FutureProvider.autoDispose<int>((ref) async {
  final data = await ref.read(apiClientProvider).get('/sync/notifications');
  final n = data is Map ? data['unread'] : null;
  return (n is num) ? n.toInt() : int.tryParse('$n') ?? 0;
});

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(notificationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Notifications')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading notifications…'),
        error: (e, _) => ErrorState('Could not load notifications.', onRetry: () => ref.invalidate(notificationsProvider)),
        data: (d) {
          final recent = (d['recent'] is List) ? (d['recent'] as List).whereType<Map>().toList() : const [];
          if (recent.isEmpty) {
            return const EmptyState('No notifications yet.', icon: Icons.notifications_none_outlined);
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(notificationsProvider),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: recent.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _NotifCard(recent[i].cast<String, dynamic>()),
            ),
          );
        },
      ),
    );
  }
}

class _NotifCard extends ConsumerWidget {
  const _NotifCard(this.n);
  final Map<String, dynamic> n;

  // Top-level routes the app can actually open. A notification link outside this
  // set (e.g. /sync-logs, /agent-releases) just marks read — no blank page.
  static const _appRoutes = {
    'customers', 'suppliers', 'products', 'categories', 'locations', 'sales-persons',
    'sales-invoices', 'purchase-invoices', 'payments', 'receipts', 'journals',
    'expenses', 'reminders', 'bank-reconciliation', 'recurring-invoices', 'einvoices',
    'analytics', 'inventory', 'companies',
  };

  bool _canOpen(String link) {
    if (link.isEmpty) return false;
    final segs = link.split('/').where((s) => s.isNotEmpty).toList();
    return segs.isNotEmpty && _appRoutes.contains(segs.first);
  }

  Future<void> _onTap(BuildContext context, WidgetRef ref) async {
    final key = '${n['id'] ?? ''}';
    final link = '${n['link'] ?? ''}';
    // Mark read first (idempotent server-side) so the badge + read state update,
    // THEN open the page only if the app has it — otherwise a tap just clears it
    // instead of pushing an unknown route (a blank screen).
    if (key.isNotEmpty && n['read'] != true) {
      try {
        await ref.read(apiClientProvider).post('/sync/notifications/read', body: {'key': key});
      } catch (_) {}
      ref.invalidate(notificationsProvider);
      ref.invalidate(notificationsUnreadProvider);
    }
    if (context.mounted && _canOpen(link)) context.push(link);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final tone = '${n['tone'] ?? ''}'.toLowerCase();
    final color = switch (tone) {
      'success' => AppColors.success,
      'danger' || 'error' => AppColors.danger,
      'warning' => const Color(0xFFD97706),
      _ => AppColors.primary,
    };
    final icon = _iconFor('${n['icon'] ?? ''}', '${n['title'] ?? ''}');
    final title = '${n['title'] ?? ''}';
    final sub = '${n['sub'] ?? ''}';
    final read = n['read'] == true;
    return AppCard(
      onTap: () => _onTap(context, ref),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38, height: 38,
            decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            alignment: Alignment.center,
            child: Icon(icon, color: color, size: 20),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: read ? FontWeight.w500 : FontWeight.w700)),
                if (sub.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(sub, style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.dateTime(n['when'] ?? n['at']), style: theme.textTheme.bodySmall),
              if (!read) ...[
                const SizedBox(height: 6),
                Container(width: 8, height: 8, decoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle)),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// Map the web's FontAwesome icon name (or the title's verb) to a Material icon.
  IconData _iconFor(String fa, String title) {
    if (fa.contains('plus') || title.contains('created')) return Icons.add_circle_outline;
    if (fa.contains('pen') || fa.contains('pencil') || title.contains('updated')) return Icons.edit_outlined;
    if (fa.contains('trash') || title.contains('deleted')) return Icons.delete_outline;
    if (fa.contains('triangle') || fa.contains('exclamation') || title.contains('failed')) return Icons.warning_amber_rounded;
    return Icons.notifications_outlined;
  }
}
