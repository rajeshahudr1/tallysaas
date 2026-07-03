import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/sync_summary.dart';
import '../../data/repositories/sync_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Tally Sync Dashboard — mirrors the web `/sync-dashboard`: connection banner,
/// disconnected warning, agent-update card, auto-sync toggles, headline stat
/// cards, a per-module breakdown (From Tally / To Tally), and recent activity.
/// Data from GET /sync/summary; actions via SyncRepository.
class SyncDashboardScreen extends ConsumerStatefulWidget {
  const SyncDashboardScreen({super.key});
  @override
  ConsumerState<SyncDashboardScreen> createState() => _SyncDashboardScreenState();
}

class _SyncDashboardScreenState extends ConsumerState<SyncDashboardScreen> {
  SyncSummary? _data;
  bool _loading = true;
  bool _busy = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    // Live refresh: re-pull the summary every 5s so the progress bars MOVE while
    // a sync is running — no loading flash (the last good data stays on screen).
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _silentRefresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final s = await ref.read(syncRepositoryProvider).summary();
      if (!mounted) return;
      setState(() {
        _data = s;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _silentRefresh() async {
    if (!mounted || _busy) return;
    try {
      final s = await ref.read(syncRepositoryProvider).summary();
      if (!mounted) return;
      setState(() => _data = s);
    } catch (_) {
      // transient — keep showing the last good data
    }
  }

  void _reload() => _load();

  Future<void> _run(Future<dynamic> Function() action, String okMsg) async {
    if (_busy) return;
    setState(() => _busy = true);
    String msg = okMsg;
    bool ok = true;
    try {
      await action();
    } on ApiException catch (e) {
      msg = e.message;
      ok = false;
    } catch (_) {
      msg = 'Something went wrong. Please try again.';
      ok = false;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), backgroundColor: ok ? null : AppColors.danger));
    _silentRefresh();
  }

  SyncRepository get _repo => ref.read(syncRepositoryProvider);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tally Sync'),
        actions: [
          TextButton(
            onPressed: _busy ? null : () => _run(() => _repo.retry(), 'Retry queued.'),
            child: const Text('Retry Failed'),
          ),
          Padding(
            padding: const EdgeInsets.only(right: AppSpacing.sm8),
            child: FilledButton.icon(
              onPressed: _busy ? null : () => _run(() => _repo.pull(), 'Sync from Tally queued.'),
              icon: const Icon(Icons.sync, size: 18),
              label: const Text('Sync'),
            ),
          ),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_data == null && _loading) {
      return const LoadingState(message: 'Loading sync status…');
    }
    if (_data == null) {
      return ErrorState('Could not load sync status.', onRetry: _reload);
    }
    final s = _data!;
    return RefreshIndicator(
      onRefresh: () async => _load(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
        children: [
          SizedBox(height: 3, child: _busy ? const LinearProgressIndicator(minHeight: 2) : null),
          const SizedBox(height: AppSpacing.sm8),
          _connectionBanner(s),
          if (!s.connected) ...[const SizedBox(height: AppSpacing.md12), _warningBanner()],
          const SizedBox(height: AppSpacing.md12),
          _overallProgress(s),
          const SizedBox(height: AppSpacing.md12),
          _agentCard(s),
          const SizedBox(height: AppSpacing.md12),
          _togglesCard(s),
          const SizedBox(height: AppSpacing.md12),
          _statGrid(s),
          const SizedBox(height: AppSpacing.md12),
          _modulesSection(s),
          const SizedBox(height: AppSpacing.md12),
          _recentSection(s),
        ],
      ),
    );
  }

  // ── Connection banner ──────────────────────────────────────────────
  Widget _connectionBanner(SyncSummary s) {
    final ok = s.connected;
    final c = ok ? AppColors.success : AppColors.danger;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      decoration: BoxDecoration(
        color: c.withOpacity(0.07),
        borderRadius: BorderRadius.circular(AppRadius.md12),
        border: Border.all(color: c.withOpacity(0.30)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Container(
              width: 40, height: 40,
              decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(AppRadius.sm8)),
              child: Icon(ok ? Icons.cloud_done : Icons.cloud_off, color: Colors.white, size: 22),
            ),
            const SizedBox(width: AppSpacing.md12),
            const Text('Local Sync Agent', style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
            const SizedBox(width: AppSpacing.sm8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(color: c.withOpacity(0.15), borderRadius: BorderRadius.circular(AppRadius.pill999)),
              child: Text(ok ? 'Connected' : 'Disconnected',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c)),
            ),
          ]),
          const SizedBox(height: AppSpacing.md12),
          Wrap(spacing: AppSpacing.lg16, runSpacing: AppSpacing.xs4, children: [
            _kv('Agent', s.agentVersion ?? '—'),
            _kv('Company', s.company ?? '—'),
            _kv('Last sync', Fmt.dateTime(s.lastSyncAt)),
          ]),
        ],
      ),
    );
  }

  Widget _kv(String k, String v) => RichText(
        text: TextSpan(
          style: const TextStyle(fontSize: 12.5),
          children: [
            TextSpan(text: '$k ', style: const TextStyle(color: AppColors.text3)),
            TextSpan(text: v, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
          ],
        ),
      );

  Widget _warningBanner() => Container(
        padding: const EdgeInsets.all(AppSpacing.md12),
        decoration: BoxDecoration(
          color: AppColors.danger.withOpacity(0.06),
          borderRadius: BorderRadius.circular(AppRadius.md12),
          border: const Border(left: BorderSide(color: AppColors.danger, width: 3)),
        ),
        child: const Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.warning_amber_rounded, color: AppColors.danger, size: 20),
          SizedBox(width: AppSpacing.sm8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Tally agent not connected',
                  style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.danger)),
              SizedBox(height: 4),
              Text('No heartbeat from the local Sync Agent recently. Start the Tally Cloud Sync Agent on the PC running Tally (with Tally open). Sync actions queue and run once it reconnects.',
                  style: TextStyle(fontSize: 12.5, color: AppColors.text2)),
            ]),
          ),
        ]),
      );

  // ── Overall sync progress (real % = Σsynced / Σtotal across modules) ─
  Widget _overallProgress(SyncSummary s) {
    int ts = 0, tt = 0;
    for (final m in s.modules) {
      ts += m.synced;
      tt += m.total;
    }
    final frac = tt > 0 ? (ts / tt).clamp(0.0, 1.0) : 0.0;
    final pct = (frac * 100).round();
    final done = pct >= 100;
    final barColor = done ? AppColors.success : AppColors.primary;
    return AppCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.speed, color: barColor, size: 18),
          const SizedBox(width: 6),
          const Expanded(
            child: Text('Overall Sync Progress',
                style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
          ),
          Text('$pct%',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: barColor)),
        ]),
        const SizedBox(height: 10),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.pill999),
          child: LinearProgressIndicator(
            value: frac,
            minHeight: 12,
            backgroundColor: const Color(0xFFE2E8F0),
            valueColor: AlwaysStoppedAnimation(barColor),
          ),
        ),
        const SizedBox(height: 8),
        Text('${Fmt.num0(ts)} of ${Fmt.num0(tt)} records synced to cloud',
            style: const TextStyle(fontSize: 12, color: AppColors.text3)),
      ]),
    );
  }

  // ── Agent update card ──────────────────────────────────────────────
  Widget _agentCard(SyncSummary s) => AppCard(
        child: Row(children: [
          Container(
            width: 38, height: 38,
            decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            child: const Icon(Icons.download_for_offline_outlined, color: AppColors.primary, size: 20),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Agent${s.agentVersion != null ? ' v${s.agentVersion}' : ''}',
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
              const SizedBox(height: 2),
              Text(s.updateAvailable ? 'A newer agent is available.' : 'The agent is up to date.',
                  style: const TextStyle(fontSize: 12.5, color: AppColors.text2)),
            ]),
          ),
          if (s.updateAvailable)
            FilledButton(
              onPressed: _busy ? null : () => _run(() => _repo.selfUpdate(), 'Agent update queued.'),
              child: const Text('Update'),
            ),
        ]),
      );

  // ── Auto-sync toggles ──────────────────────────────────────────────
  Widget _togglesCard(SyncSummary s) => AppCard(
        child: Column(children: [
          _toggleRow('Auto-sync', 'Master switch for the agent’s automatic loop', s.syncEnabled,
              (v) => _run(() => _repo.setDirection(syncEnabled: v), 'Auto-sync ${v ? 'ON' : 'OFF'}.')),
          const Divider(height: 18),
          _toggleRow('Push  ·  Cloud → Tally', 'Auto-send cloud edits to Tally', s.pushEnabled,
              (v) => _run(() => _repo.setDirection(pushEnabled: v), 'Push ${v ? 'ON' : 'OFF'}.')),
          const Divider(height: 18),
          _toggleRow('Pull  ·  Tally → Cloud', 'Auto-import Tally changes to the cloud', s.pullEnabled,
              (v) => _run(() => _repo.setDirection(pullEnabled: v), 'Pull ${v ? 'ON' : 'OFF'}.')),
          const Divider(height: 18),
          _toggleRow('Auto-update agent', 'Keep the desktop agent on the latest version', s.autoUpdate,
              (v) => _run(() => _repo.setAutoUpdate(v), 'Auto-update ${v ? 'ON' : 'OFF'}.')),
        ]),
      );

  Widget _toggleRow(String title, String sub, bool value, ValueChanged<bool> onChanged) => Row(
        children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
              const SizedBox(height: 1),
              Text(sub, style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
            ]),
          ),
          Switch(value: value, onChanged: _busy ? null : onChanged),
        ],
      );

  // ── Stat grid (Connection · Last Sync · Total · Failed) ────────────
  Widget _statGrid(SyncSummary s) => Row(children: [
        Expanded(child: _stat('Connection', s.connected ? 'Connected' : 'Disconnected', Icons.link,
            s.connected ? AppColors.success : AppColors.danger)),
        const SizedBox(width: AppSpacing.sm8),
        Expanded(child: _stat('Failed', Fmt.num0(s.failed), Icons.error_outline,
            s.failed > 0 ? AppColors.warn : AppColors.success)),
        const SizedBox(width: AppSpacing.sm8),
        Expanded(child: _stat('Synced', Fmt.num0(s.totalSynced), Icons.check_circle_outline, AppColors.primary)),
      ]);

  Widget _stat(String label, String value, IconData icon, Color color) => AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 30, height: 30,
            decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            child: Icon(icon, color: color, size: 17),
          ),
          const SizedBox(height: 8),
          Text(label, style: const TextStyle(fontSize: 11, color: AppColors.text3, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text(value, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: AppColors.text1)),
        ]),
      );

  // ── Per-module breakdown ───────────────────────────────────────────
  Widget _modulesSection(SyncSummary s) => AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Modules', style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
          const SizedBox(height: AppSpacing.sm8),
          if (s.modules.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('No modules yet.', style: TextStyle(color: AppColors.text3)))
          else
            for (final m in s.modules) _moduleRow(m),
        ]),
      );

  Widget _moduleRow(SyncModule m) {
    final pct = (m.progress * 100).round();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(child: Text(m.module, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
            Text('${Fmt.num0(m.synced)} / ${Fmt.num0(m.total)}',
                style: const TextStyle(fontSize: 12.5, color: AppColors.text2)),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.pill999),
                child: LinearProgressIndicator(
                  value: m.progress,
                  minHeight: 7,
                  backgroundColor: const Color(0xFFEEF1F5),
                  valueColor: AlwaysStoppedAnimation(pct >= 100 ? AppColors.success : AppColors.primary),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text('$pct%', style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            if (m.pending > 0) _miniChip('${Fmt.num0(m.pending)} pending', AppColors.warn),
            if (m.failed > 0) ...[const SizedBox(width: 6), _miniChip('${Fmt.num0(m.failed)} failed', AppColors.danger)],
            const Spacer(),
            _modBtn(Icons.download, 'From Tally', () => _run(() => _repo.retry(module: m.key, direction: 'pull'), '${m.module}: pull from Tally queued.')),
            const SizedBox(width: 6),
            _modBtn(Icons.upload, 'To Tally', () => _run(() => _repo.retry(module: m.key, direction: 'push'), '${m.module}: push to Tally queued.')),
          ]),
          if (m.lastSync != null) ...[
            const SizedBox(height: 4),
            Text('Last sync ${Fmt.dateTime(m.lastSync)}', style: const TextStyle(fontSize: 11, color: AppColors.text3)),
          ],
          const Divider(height: 14),
        ],
      ),
    );
  }

  Widget _miniChip(String t, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
        child: Text(t, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: c)),
      );

  Widget _modBtn(IconData icon, String label, VoidCallback onTap) => OutlinedButton.icon(
        onPressed: _busy ? null : onTap,
        icon: Icon(icon, size: 15),
        label: Text(label, style: const TextStyle(fontSize: 12)),
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          minimumSize: const Size(0, 32),
          foregroundColor: AppColors.primary,
          side: const BorderSide(color: AppColors.border),
        ),
      );

  // ── Recent sync activity ───────────────────────────────────────────
  Widget _recentSection(SyncSummary s) => AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Expanded(child: Text('Recent Sync Activity', style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1))),
            TextButton(onPressed: () => context.push('/sync-logs'), child: const Text('View all logs')),
          ]),
          const SizedBox(height: AppSpacing.sm8),
          if (s.recent.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('No recent activity.', style: TextStyle(color: AppColors.text3)))
          else
            for (final r in s.recent) _recentRow(r),
        ]),
      );

  Widget _recentRow(SyncRecent r) {
    final st = (r.status ?? '').toLowerCase();
    final c = st == 'synced' ? AppColors.success : st == 'failed' ? AppColors.danger : AppColors.warn;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(children: [
        Container(
          width: 32, height: 32,
          decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.10), borderRadius: BorderRadius.circular(AppRadius.sm8)),
          child: const Icon(Icons.sync, color: AppColors.primary, size: 16),
        ),
        const SizedBox(width: AppSpacing.md12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(r.module ?? '—', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.text1)),
            Text(r.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.text3)),
          ]),
        ),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
            child: Text(r.status ?? '—', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: c)),
          ),
          const SizedBox(height: 3),
          Text(Fmt.dateTime(r.createdAt), style: const TextStyle(fontSize: 10.5, color: AppColors.text3)),
        ]),
      ]),
    );
  }
}
