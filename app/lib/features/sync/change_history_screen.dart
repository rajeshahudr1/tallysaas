import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Change History — the company's audit feed (GET /history): every create /
/// update / delete on any module, who/where it came from (cloud or Tally), and
/// when. Mirrors the web's Change History page. Read-only list (newest first).
final _historyProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/history', query: {'per_page': 50});
  final rows = data is Map ? (data['data'] as List<dynamic>? ?? const []) : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

class ChangeHistoryScreen extends ConsumerWidget {
  const ChangeHistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_historyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Change History')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading history…'),
        error: (e, _) => ErrorState('Could not load change history.', onRetry: () => ref.invalidate(_historyProvider)),
        data: (rows) {
          if (rows.isEmpty) {
            return const EmptyState('No changes recorded yet.', icon: Icons.history);
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_historyProvider),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
              itemBuilder: (_, i) => _HistoryCard(rows[i]),
            ),
          );
        },
      ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard(this.r);
  final Map<String, dynamic> r;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final action = '${r['action'] ?? ''}'.toLowerCase();
    final (icon, color) = switch (action) {
      'created' => (Icons.add_circle_outline, AppColors.success),
      'updated' => (Icons.edit_outlined, AppColors.primary),
      'deleted' => (Icons.delete_outline, AppColors.danger),
      _ => (Icons.sync_alt, AppColors.text3),
    };
    final type = '${r['record_type'] ?? r['module'] ?? ''}';
    final label = '${r['record_label'] ?? ''}';
    final source = '${r['source'] ?? ''}';
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36, height: 36,
            decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            alignment: Alignment.center,
            child: Icon(icon, color: color, size: 20),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('$type ${action.isEmpty ? '' : action}'.trim(), style: theme.textTheme.titleSmall),
                if (label.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(label, style: theme.textTheme.bodySmall),
                ],
                if (source.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  _SourcePill(source),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Text(Fmt.dateTime(r['created_at'] ?? r['at']), style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _SourcePill extends StatelessWidget {
  const _SourcePill(this.source);
  final String source;
  @override
  Widget build(BuildContext context) {
    final fromTally = source.toLowerCase() == 'tally';
    final c = fromTally ? AppColors.primary : AppColors.text3;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
      child: Text(fromTally ? 'From Tally' : 'From Cloud',
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: c)),
    );
  }
}
