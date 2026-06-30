import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/sync_log.dart';
import '../../data/models/sync_summary.dart';
import '../../data/repositories/sync_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Bundles the two read-only sync calls so the screen can render (and
/// refresh) connectivity + recent logs from a single async state.
class _SyncData {
  const _SyncData({required this.summary, required this.logs});
  final SyncSummary summary;
  final List<SyncLog> logs;
}

/// Combined loader: summary + first page of logs, fetched in parallel.
/// `autoDispose` so it re-runs fresh each time the screen is entered, and
/// `ref.invalidate` drives pull-to-refresh.
final _syncDataProvider = FutureProvider.autoDispose<_SyncData>((ref) async {
  final repo = ref.watch(syncRepositoryProvider);
  // Fire both reads in parallel. `await (a, b).wait` awaits BOTH (so neither
  // future is left dangling/unhandled if the other throws) and keeps each
  // element's static type — no casts, no extra imports.
  final (summary, logs) = await (repo.summary(), repo.logs(perPage: 20)).wait;
  return _SyncData(summary: summary, logs: logs.items);
});

/// Friendly error text for the [ErrorState]. `(a, b).wait` wraps any failure in
/// a [ParallelWaitError], so we dig out the first real error before unwrapping
/// an [ApiException]'s already-friendly `message`.
String _messageFor(Object error) {
  var e = error;
  if (e is ParallelWaitError) {
    final errors = e.errors;
    if (errors is (Object?, Object?)) {
      e = errors.$1 ?? errors.$2 ?? error;
    }
  }
  if (e is ApiException) return e.message;
  return 'Could not load sync status.';
}

/// Tally Sync — read-only status of the desktop agent's push/pull to Tally.
/// Top: a summary card (connection status pill, last-seen time, synced /
/// pending / failed counts). Below: a "Recent activity" list of sync logs.
/// No actions — the desktop agent runs the sync; the app only observes.
class SyncScreen extends ConsumerWidget {
  const SyncScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_syncDataProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Sync Dashboard')),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading sync status…'),
        error: (e, _) => ErrorState(
          _messageFor(e),
          onRetry: () => ref.invalidate(_syncDataProvider),
        ),
        data: (data) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(_syncDataProvider),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
            ),
            children: [
              if (!data.summary.connected) ...[
                const _AgentBanner(),
                const SizedBox(height: AppSpacing.md12),
              ],
              _SummaryCard(data.summary),
              const SizedBox(height: AppSpacing.md12),
              _TogglesRow(data.summary),
              const SizedBox(height: AppSpacing.xl24),
              const _SectionHeader('Module-wise Sync'),
              const SizedBox(height: AppSpacing.md12),
              if (data.summary.modules.isEmpty)
                const EmptyState('No modules synced yet.', icon: Icons.layers_outlined)
              else
                ...data.summary.modules.map((m) => Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                      child: _ModuleCard(m),
                    )),
              const SizedBox(height: AppSpacing.xl24),
              const _SectionHeader('Recent activity'),
              const SizedBox(height: AppSpacing.md12),
              if (data.logs.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: AppSpacing.xxl32),
                  child: EmptyState(
                    'No sync activity yet.',
                    icon: Icons.history,
                  ),
                )
              else
                ...data.logs.map((l) => Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                      child: _LogCard(l),
                    )),
            ],
          ),
        ),
      ),
    );
  }
}

/// Red banner shown when the desktop agent hasn't sent a heartbeat — mirrors
/// the web's "Tally agent not connected" warning.
class _AgentBanner extends StatelessWidget {
  const _AgentBanner();
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md12),
      decoration: BoxDecoration(
        color: AppColors.danger.withOpacity(0.08),
        borderRadius: BorderRadius.circular(AppRadius.sm8),
        border: Border.all(color: AppColors.danger.withOpacity(0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.danger, size: 22),
          const SizedBox(width: AppSpacing.sm8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Tally agent not connected',
                    style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.danger)),
                const SizedBox(height: 2),
                Text(
                  'No heartbeat from the local Sync Agent recently. Start the Tally Cloud Sync Agent on the PC running Tally. Sync stays paused until it reconnects.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The four agent toggles (Auto-sync / Push / Pull / Update) as ON/OFF chips —
/// mirrors the web's toggle strip. Read-only here (change them in Settings).
class _TogglesRow extends StatelessWidget {
  const _TogglesRow(this.s);
  final SyncSummary s;
  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.sm8,
      runSpacing: AppSpacing.sm8,
      children: [
        _toggle('Auto-sync', s.autoUpdate),
        _toggle('Push', s.pushEnabled),
        _toggle('Pull', s.pullEnabled),
        _toggle('Update', s.syncEnabled),
      ],
    );
  }

  Widget _toggle(String label, bool on) {
    final c = on ? AppColors.success : AppColors.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: c.withOpacity(0.10),
        borderRadius: BorderRadius.circular(AppRadius.pill999),
        border: Border.all(color: c.withOpacity(0.3)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        const SizedBox(width: 6),
        Text(on ? 'ON' : 'OFF', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: c)),
      ]),
    );
  }
}

/// One module row in the Module-wise Sync section: label, synced/total + a
/// progress bar, pending/failed badges, and the last-sync time.
class _ModuleCard extends StatelessWidget {
  const _ModuleCard(this.m);
  final SyncModule m;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pct = m.total > 0 ? (m.synced / m.total).clamp(0.0, 1.0) : 0.0;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(m.module, style: theme.textTheme.titleSmall)),
              Text('${m.synced} / ${m.total}',
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct,
              minHeight: 6,
              backgroundColor: AppColors.muted.withOpacity(0.2),
              valueColor: const AlwaysStoppedAnimation(AppColors.success),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('${(pct * 100).round()}% synced', style: theme.textTheme.bodySmall),
              const Spacer(),
              if (m.pending > 0) ...[
                _badge('Pending ${m.pending}', const Color(0xFFD97706)),
                const SizedBox(width: 6),
              ],
              if (m.failed > 0) _badge('Failed ${m.failed}', AppColors.danger),
              if (m.lastSync != null) ...[
                const SizedBox(width: 6),
                Text(Fmt.date(m.lastSync), style: theme.textTheme.bodySmall),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _badge(String text, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
        child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: c)),
      );
}

/// Connection state + headline counts. The desktop agent's connectivity is
/// shown as a [StatusPill]; last-seen and agent version sit beneath it; the
/// synced / pending / failed totals fan out across the bottom.
class _SummaryCard extends StatelessWidget {
  const _SummaryCard(this.s);
  final SyncSummary s;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: (s.connected ? AppColors.success : AppColors.muted)
                      .withOpacity(0.12),
                  borderRadius: BorderRadius.circular(AppRadius.sm8),
                ),
                alignment: Alignment.center,
                child: Icon(
                  s.connected ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
                  color: s.connected ? AppColors.success : AppColors.muted,
                  size: 22,
                ),
              ),
              const SizedBox(width: AppSpacing.md12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Tally Agent', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 2),
                    Text(
                      s.company ?? 'This company',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              StatusPill(s.connectionLabel),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          _MetaRow(
            label: 'Last seen',
            value: s.lastSeenAt != null ? Fmt.date(s.lastSeenAt) : 'Never',
          ),
          if (s.agentVersion != null)
            _MetaRow(label: 'Agent version', value: s.agentVersion!),
          const Divider(height: AppSpacing.xl24),
          Row(
            children: [
              _StatCell(
                label: 'Synced',
                value: s.totalSynced,
                color: AppColors.success,
              ),
              _StatCell(
                label: 'Pending',
                value: s.pending,
                color: AppColors.warn,
              ),
              _StatCell(
                label: 'Failed',
                value: s.failed,
                color: AppColors.danger,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A `label: value` line in the summary card meta block.
class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Text(label, style: theme.textTheme.bodySmall),
          const Spacer(),
          Text(
            value,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

/// One of the three headline counters across the bottom of the summary card.
class _StatCell extends StatelessWidget {
  const _StatCell({
    required this.label,
    required this.value,
    required this.color,
  });
  final String label;
  final int value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Column(
        children: [
          Text(
            Fmt.num0(value),
            style: theme.textTheme.titleLarge?.copyWith(color: color),
          ),
          const SizedBox(height: 2),
          Text(label, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

/// A bold section title above the recent-activity list.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: Theme.of(context).textTheme.titleMedium);
  }
}

/// One sync-log row: title (record_type/module) + direction, a StatusPill for
/// the sync state, the time, and any message the agent reported.
class _LogCard extends StatelessWidget {
  const _LogCard(this.log);
  final SyncLog log;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleParts = <String>[
      if (log.module != null && log.module != log.recordType) log.module!,
      if (log.direction != null) log.direction!,
    ];
    final when = log.syncedAt ?? log.createdAt;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(log.title, style: theme.textTheme.titleMedium),
                    if (subtitleParts.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        subtitleParts.join('  ·  '),
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                    const SizedBox(height: 2),
                    Text(Fmt.date(when), style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm8),
              if (log.status != null) StatusPill(log.status!),
            ],
          ),
          if (log.message != null) ...[
            const SizedBox(height: AppSpacing.sm8),
            Text(
              log.message!,
              style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text2),
            ),
          ],
        ],
      ),
    );
  }
}
