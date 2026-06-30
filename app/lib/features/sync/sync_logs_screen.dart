import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/sync_log.dart';
import '../../data/repositories/sync_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Sync Logs — the full, dedicated push/pull log feed (GET /sync/logs), newest
/// first. Mirrors the web's Sync Logs page. Each row shows the module / record,
/// the direction (push = To Tally, pull = From Tally), a status pill and time.
final _logsProvider = FutureProvider.autoDispose<List<SyncLog>>((ref) async {
  final res = await ref.read(syncRepositoryProvider).logs(perPage: 50);
  return res.items;
});

class SyncLogsScreen extends ConsumerWidget {
  const SyncLogsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_logsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Sync Logs')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading sync logs…'),
        error: (e, _) => ErrorState('Could not load sync logs.', onRetry: () => ref.invalidate(_logsProvider)),
        data: (logs) {
          if (logs.isEmpty) {
            return const EmptyState('No sync logs yet.', icon: Icons.history);
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_logsProvider),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: logs.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _LogCard(logs[i]),
            ),
          );
        },
      ),
    );
  }
}

class _LogCard extends StatelessWidget {
  const _LogCard(this.l);
  final SyncLog l;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dir = (l.direction ?? '').toLowerCase();
    final dirLabel = dir == 'push' ? 'To Tally' : (dir == 'pull' ? 'From Tally' : dir);
    final title = [l.module, l.recordType].where((s) => s != null && s.isNotEmpty).join(' · ');
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(dir == 'push' ? Icons.cloud_upload_outlined : Icons.cloud_download_outlined,
              size: 20, color: AppColors.primary),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title.isEmpty ? 'Sync' : title, style: theme.textTheme.titleSmall),
                if (dirLabel.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(dirLabel, style: theme.textTheme.bodySmall),
                ],
                if (l.message != null && l.message!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(l.message!, style: theme.textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (l.status != null) StatusPill(l.status!),
              const SizedBox(height: 6),
              Text(Fmt.dateTime(l.createdAt), style: theme.textTheme.bodySmall),
            ],
          ),
        ],
      ),
    );
  }
}
