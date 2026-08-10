import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// The licences a platform operator can configure — `{id, holder}` rows.
final _licensesProvider =
    FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final data = await ref
      .read(apiClientProvider)
      .get('/super-admin/licenses', query: {'per_page': 100});
  final rows = (data is Map && data['data'] is List)
      ? data['data'] as List
      : (data is List ? data : const []);
  return rows.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
});

final _gpsSettingsProvider =
    FutureProvider.autoDispose.family<Map<String, dynamic>, int>((ref, licenseId) async {
  final data = await ref
      .read(apiClientProvider)
      .get('/super-admin/gps-settings', query: {'license_id': licenseId});
  final map = (data is Map) ? data.cast<String, dynamic>() : const <String, dynamic>{};
  return (map['settings'] is Map)
      ? (map['settings'] as Map).cast<String, dynamic>()
      : <String, dynamic>{};
});

/// GPS Tracking — how often a salesman's phone reports its location, and
/// during which hours.
///
/// This config is PER LICENCE and the API only exposes it under
/// `/super-admin`, so the screen is for a platform operator; a company admin
/// has no endpoint to call. The menu entry is gated the same way, rather than
/// showing an item that would only ever 403.
class GpsSettingsScreen extends ConsumerStatefulWidget {
  const GpsSettingsScreen({super.key});

  @override
  ConsumerState<GpsSettingsScreen> createState() => _GpsSettingsScreenState();
}

class _GpsSettingsScreenState extends ConsumerState<GpsSettingsScreen> {
  int? _licenseId;

  final _interval = TextEditingController();
  final _minMove = TextEditingController();
  final _from = TextEditingController();
  final _to = TextEditingController();

  bool _enabled = false;
  bool _hourly = false;
  bool _partVisit = true;
  bool _onCreate = false;

  /// Which licence's settings the controllers currently hold, so switching
  /// licence re-hydrates instead of carrying the previous one's values over.
  int? _hydratedFor;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_interval, _minMove, _from, _to]) {
      c.dispose();
    }
    super.dispose();
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  void _hydrate(Map<String, dynamic> s, int licenseId) {
    _hydratedFor = licenseId;
    _enabled = s['gps_enabled'] == true;
    _hourly = s['track_hourly'] == true;
    _partVisit = s['track_part_visit'] != false;
    _onCreate = s['track_on_create'] == true;
    _interval.text = '${s['hourly_interval_min'] ?? 60}';
    _minMove.text = '${s['min_move_m'] ?? 100}';
    _from.text = '${s['time_from'] ?? '07:00'}';
    _to.text = '${s['time_to'] ?? '20:00'}';
  }

  Future<void> _save() async {
    final licenseId = _licenseId;
    if (licenseId == null || _busy) return;

    // The API defaults anything unparseable, but a silently-ignored value is
    // worse than being told, so the obvious mistakes are caught here.
    final interval = int.tryParse(_interval.text.trim());
    final minMove = int.tryParse(_minMove.text.trim());
    if (interval == null || interval <= 0) {
      _snack('Ping interval must be a number of minutes greater than 0.');
      return;
    }
    if (minMove == null || minMove <= 0) {
      _snack('Minimum movement must be a number of metres greater than 0.');
      return;
    }
    final timeRe = RegExp(r'^\d{2}:\d{2}$');
    if (!timeRe.hasMatch(_from.text.trim()) || !timeRe.hasMatch(_to.text.trim())) {
      _snack('Times must look like 07:00.');
      return;
    }

    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/super-admin/gps-settings', body: {
        'license_id': licenseId,
        'gps_enabled': _enabled,
        'track_hourly': _hourly,
        'hourly_interval_min': interval,
        'track_part_visit': _partVisit,
        'track_on_create': _onCreate,
        'time_from': _from.text.trim(),
        'time_to': _to.text.trim(),
        'min_move_m': minMove,
      });
      ref.invalidate(_gpsSettingsProvider(licenseId));
      _snack('GPS tracking settings saved.');
    } on ApiException catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Could not save the GPS settings.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final licences = ref.watch(_licensesProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('GPS Tracking'),
        actions: const [ModuleInfoButton('gps-tracking')],
      ),
      body: licences.when(
        loading: () => const LoadingState(message: 'Loading licences…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load licences.',
          onRetry: () async => ref.invalidate(_licensesProvider),
        ),
        data: (rows) {
          if (rows.isEmpty) {
            return const Center(child: Text('No licences to configure.'));
          }
          _licenseId ??= int.tryParse('${rows.first['id']}');

          return ListView(
            padding: const EdgeInsets.all(AppSpacing.lg16),
            children: [
              DropdownButtonFormField<int>(
                value: _licenseId,
                decoration: const InputDecoration(labelText: 'Licence'),
                isExpanded: true,
                items: [
                  for (final r in rows)
                    DropdownMenuItem(
                      value: int.tryParse('${r['id']}'),
                      child: Text('${r['holder_name'] ?? r['holder'] ?? 'Licence ${r['id']}'}'),
                    ),
                ],
                onChanged: (v) => setState(() {
                  _licenseId = v;
                  _hydratedFor = null; // force a re-hydrate for the new licence
                }),
              ),
              const SizedBox(height: AppSpacing.lg16),
              if (_licenseId != null) _settings(theme, _licenseId!),
            ],
          );
        },
      ),
    );
  }

  Widget _settings(ThemeData theme, int licenseId) {
    final async = ref.watch(_gpsSettingsProvider(licenseId));
    return async.when(
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.xxl32),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => ErrorState(
        e is ApiException ? e.message : 'Could not load these settings.',
        onRetry: () async => ref.invalidate(_gpsSettingsProvider(licenseId)),
      ),
      data: (s) {
        if (_hydratedFor != licenseId) _hydrate(s, licenseId);

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppCard(
              child: Column(
                children: [
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _enabled,
                    onChanged: (v) => setState(() => _enabled = v),
                    title: const Text('GPS tracking'),
                    subtitle: const Text(
                        'Master switch — off means the app captures nothing.'),
                  ),
                  const Divider(height: 1),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _hourly,
                    onChanged: _enabled ? (v) => setState(() => _hourly = v) : null,
                    title: const Text('Periodic pings'),
                    subtitle: const Text('Report location on a timer.'),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _partVisit,
                    onChanged: _enabled ? (v) => setState(() => _partVisit = v) : null,
                    title: const Text('Part visits'),
                    subtitle: const Text('Capture a fix on a part-visit entry.'),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _onCreate,
                    onChanged: _enabled ? (v) => setState(() => _onCreate = v) : null,
                    title: const Text('On voucher create'),
                    subtitle: const Text('Capture a fix when a voucher is saved.'),
                  ),
                ],
              ),
            ),

            const DetailSection('Limits'),
            Row(
              children: [
                Expanded(
                  child: AppTextField(
                    controller: _interval,
                    label: 'Ping every (min)',
                    keyboardType: TextInputType.number,
                    enabled: _enabled,
                  ),
                ),
                const SizedBox(width: AppSpacing.md12),
                Expanded(
                  child: AppTextField(
                    controller: _minMove,
                    label: 'Min movement (m)',
                    keyboardType: TextInputType.number,
                    enabled: _enabled,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(
                  child: AppTextField(
                    controller: _from,
                    label: 'Active from',
                    hint: '07:00',
                    enabled: _enabled,
                  ),
                ),
                const SizedBox(width: AppSpacing.md12),
                Expanded(
                  child: AppTextField(
                    controller: _to,
                    label: 'Active to',
                    hint: '20:00',
                    enabled: _enabled,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            Text(
              'Outside these hours the phone stops reporting, and a fix closer '
              'than the minimum movement is dropped — both exist to spare the '
              "salesman's battery and data.",
              style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
            ),
            const SizedBox(height: AppSpacing.lg16),
            AppButton(label: 'Save Settings', loading: _busy, onPressed: _save),
          ],
        );
      },
    );
  }
}
