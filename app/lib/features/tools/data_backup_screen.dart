import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import '../../core/module_info.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/status_pill.dart';

/// Backup settings + the recent run log, fetched together.
class _BackupData {
  const _BackupData({required this.settings, required this.runs});
  final Map<String, dynamic> settings;
  final List<Map<String, dynamic>> runs;
}

final _backupProvider = FutureProvider.autoDispose<_BackupData>((ref) async {
  final api = ref.read(apiClientProvider);
  final results = await Future.wait([
    api.get('/backup/settings'),
    api.get('/backup/runs'),
  ]);

  final settings = (results[0] is Map)
      ? (results[0] as Map).cast<String, dynamic>()
      : <String, dynamic>{};
  final runsRaw = (results[1] is Map && (results[1] as Map)['data'] is List)
      ? ((results[1] as Map)['data'] as List)
      : const [];

  return _BackupData(
    settings: settings,
    runs: runsRaw
        .whereType<Map>()
        .map((m) => m.cast<String, dynamic>())
        .toList(growable: false),
  );
});

/// Data Backup — the desktop Agent copies your Tally data on a schedule. This
/// screen sets that schedule, queues a run, and shows what the Agent actually
/// did. The copying itself happens on the machine running the Agent, not here.
class DataBackupScreen extends ConsumerStatefulWidget {
  const DataBackupScreen({super.key});

  @override
  ConsumerState<DataBackupScreen> createState() => _DataBackupScreenState();
}

class _DataBackupScreenState extends ConsumerState<DataBackupScreen> {
  final _destination = TextEditingController();
  final _keepCopies = TextEditingController();

  bool _enabled = false;
  String _frequency = 'daily';
  String _runAt = '02:00:00';
  bool _hydrated = false;
  bool _busy = false;

  static final _stamp = DateFormat('dd MMM yyyy, hh:mm a');

  @override
  void dispose() {
    _destination.dispose();
    _keepCopies.dispose();
    super.dispose();
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  String _fmt(Object? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso.toString());
    return d == null ? iso.toString() : _stamp.format(d.toLocal());
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_enabled && _destination.text.trim().isEmpty) {
      _snack('A destination folder on the Agent machine is required.');
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).put('/backup/settings', body: {
        'enabled': _enabled,
        'destination_path': _destination.text.trim(),
        'frequency': _frequency,
        'run_at': _runAt,
        'keep_copies': int.tryParse(_keepCopies.text.trim()) ?? 7,
      });
      ref.invalidate(_backupProvider);
      _snack('Backup settings saved.');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save the backup settings.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _runNow() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/backup/run-now');
      ref.invalidate(_backupProvider);
      // The API only QUEUES a command — the Agent picks it up on its next poll.
      _snack('Backup queued — the Agent will run it shortly.');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not queue the backup.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pickTime() async {
    final parts = _runAt.split(':');
    final initial = TimeOfDay(
      hour: int.tryParse(parts.first) ?? 2,
      minute: parts.length > 1 ? (int.tryParse(parts[1]) ?? 0) : 0,
    );
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked == null) return;
    setState(() {
      final hh = picked.hour.toString().padLeft(2, '0');
      final mm = picked.minute.toString().padLeft(2, '0');
      _runAt = '$hh:$mm:00';
    });
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(_backupProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canEdit = user?.can('data-backup', 'edit') ?? false;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Data Backup'),
        actions: const [ModuleInfoButton('data-backup')],
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading backup settings…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load backup settings.',
          onRetry: () async => ref.invalidate(_backupProvider),
        ),
        data: (d) {
          if (!_hydrated) {
            _hydrated = true;
            _enabled = d.settings['enabled'] == true;
            _destination.text = (d.settings['destination_path'] ?? '').toString();
            _frequency = (d.settings['frequency'] ?? 'daily').toString();
            _runAt = (d.settings['run_at'] ?? '02:00:00').toString();
            _keepCopies.text = '${d.settings['keep_copies'] ?? 7}';
          }

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_backupProvider),
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.lg16),
              children: [
                const DetailSection('Schedule', first: true),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _enabled,
                  onChanged: canEdit ? (v) => setState(() => _enabled = v) : null,
                  title: const Text('Automatic backups'),
                  subtitle: const Text('The desktop Agent copies your Tally data.'),
                ),
                const SizedBox(height: AppSpacing.md12),
                AppTextField(
                  controller: _destination,
                  label: 'Destination folder',
                  hint: r'A path on the Agent machine, e.g. D:\TallyBackups',
                  enabled: canEdit,
                ),
                const SizedBox(height: AppSpacing.md12),
                DropdownButtonFormField<String>(
                  value: _frequency,
                  decoration: const InputDecoration(labelText: 'Frequency'),
                  items: const [
                    DropdownMenuItem(value: 'daily', child: Text('Daily')),
                    DropdownMenuItem(value: 'weekly', child: Text('Weekly')),
                    DropdownMenuItem(value: 'monthly', child: Text('Monthly')),
                  ],
                  onChanged:
                      canEdit ? (v) => setState(() => _frequency = v ?? 'daily') : null,
                ),
                const SizedBox(height: AppSpacing.md12),
                Row(
                  children: [
                    Expanded(
                      child: InkWell(
                        onTap: canEdit ? _pickTime : null,
                        child: InputDecorator(
                          decoration: const InputDecoration(labelText: 'Run at'),
                          child: Text(_runAt.substring(0, 5)),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.md12),
                    Expanded(
                      child: AppTextField(
                        controller: _keepCopies,
                        label: 'Keep copies',
                        keyboardType: TextInputType.number,
                        enabled: canEdit,
                      ),
                    ),
                  ],
                ),
                if (canEdit) ...[
                  const SizedBox(height: AppSpacing.lg16),
                  AppButton(
                    label: 'Save Settings',
                    loading: _busy,
                    onPressed: _save,
                  ),
                  const SizedBox(height: AppSpacing.sm8),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _runNow,
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Back up now'),
                  ),
                ],

                DetailSection('Recent runs (${d.runs.length})'),
                if (d.runs.isEmpty)
                  Text(
                    'No backup runs recorded yet. Runs appear here once the '
                    'Agent has done one.',
                    style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
                  )
                else
                  for (final r in d.runs) ...[
                    AppCard(
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(_fmt(r['started_at']),
                                    style: theme.textTheme.titleMedium),
                                const SizedBox(height: 3),
                                Text(
                                  [
                                    if (r['files_copied'] != null)
                                      '${r['files_copied']} files',
                                    if (r['finished_at'] != null)
                                      'finished ${_fmt(r['finished_at'])}',
                                  ].join('  •  '),
                                  style: theme.textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          StatusPill('${r['status'] ?? 'unknown'}'),
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
}
