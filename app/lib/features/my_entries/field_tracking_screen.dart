import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../data/models/field_dashboard.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/loading_state.dart';

/// One GPS ping from a salesman's device.
class _Ping {
  const _Ping({this.salesPerson, this.source, this.lat, this.lng, this.movedM, this.at});
  final String? salesPerson;
  final String? source;
  final double? lat;
  final double? lng;
  final num? movedM;
  final String? at;

  factory _Ping.fromJson(Map<String, dynamic> j) => _Ping(
        salesPerson: j['sales_person']?.toString(),
        source: j['source']?.toString(),
        lat: _toDouble(j['lat']),
        lng: _toDouble(j['lng']),
        movedM: _toNum(j['moved_m']),
        at: j['captured_at']?.toString(),
      );
}

/// The tracking report's two feeds, fetched together for one date/salesman.
class _TrackingData {
  const _TrackingData({required this.visits, required this.pings});
  final List<FieldVisit> visits;
  final List<_Ping> pings;
}

class _TrackingQuery {
  const _TrackingQuery({required this.date, this.salesPersonId});
  final String date;
  final int? salesPersonId;

  @override
  bool operator ==(Object other) =>
      other is _TrackingQuery &&
      other.date == date &&
      other.salesPersonId == salesPersonId;

  @override
  int get hashCode => Object.hash(date, salesPersonId);
}

final _trackingProvider =
    FutureProvider.autoDispose.family<_TrackingData, _TrackingQuery>((ref, q) async {
  final api = ref.read(apiClientProvider);
  final query = <String, dynamic>{
    if (q.date.isNotEmpty) 'date': q.date,
    if (q.salesPersonId != null) 'sales_person_id': q.salesPersonId,
  };

  // Both feeds describe the same window, so they are fetched together.
  final results = await Future.wait([
    api.get('/field/visits', query: query),
    api.get('/field/locations', query: query),
  ]);

  List rowsOf(dynamic data) => (data is Map && data['data'] is List)
      ? data['data'] as List
      : (data is List ? data : const []);

  return _TrackingData(
    visits: rowsOf(results[0])
        .whereType<Map>()
        .map((m) => FieldVisit.fromJson(m.cast<String, dynamic>()))
        .toList(growable: false),
    pings: rowsOf(results[1])
        .whereType<Map>()
        .map((m) => _Ping.fromJson(m.cast<String, dynamic>()))
        .toList(growable: false),
  );
});

/// Field Tracking report — the day's outlet visits and the GPS pings behind
/// them. The API scopes a salesman to their own rows regardless, so the
/// salesman filter only does anything for an approver.
class FieldTrackingScreen extends ConsumerStatefulWidget {
  const FieldTrackingScreen({super.key});

  @override
  ConsumerState<FieldTrackingScreen> createState() => _FieldTrackingScreenState();
}

class _FieldTrackingScreenState extends ConsumerState<FieldTrackingScreen> {
  static final _iso = DateFormat('yyyy-MM-dd');
  static final _stamp = DateFormat('dd MMM, hh:mm a');

  late DateTime _date = DateTime.now();
  int? _salesPersonId;

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  String _fmtStamp(String? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso);
    return d == null ? iso : _stamp.format(d.toLocal());
  }

  Future<void> _openMap(double? lat, double? lng) async {
    if (lat == null || lng == null) return;
    final uri = Uri.parse('geo:$lat,$lng?q=$lat,$lng');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      // No maps app — fall back to the browser rather than failing silently.
      await launchUrl(
        Uri.parse('https://www.google.com/maps/search/?api=1&query=$lat,$lng'),
        mode: LaunchMode.externalApplication,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _TrackingQuery(date: _iso.format(_date), salesPersonId: _salesPersonId);
    final async = ref.watch(_trackingProvider(q));
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tracking Report'),
        actions: [
          const ModuleInfoButton('field-tracking'),
          IconButton(
            icon: const Icon(Icons.calendar_today_outlined),
            tooltip: 'Pick date',
            onPressed: _pickDate,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, 0,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(DateFormat('EEE, dd MMM yyyy').format(_date),
                      style: theme.textTheme.titleMedium),
                ),
                TextButton(onPressed: _pickDate, child: const Text('Change')),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: FkDropdown(
              label: 'Sales Person',
              endpoint: '/sales-persons',
              value: _salesPersonId,
              onChanged: (v) => setState(() => _salesPersonId = v),
            ),
          ),
          Expanded(
            child: async.when(
              loading: () => const LoadingState(message: 'Loading tracking…'),
              error: (e, _) => ErrorState(
                e is ApiException ? e.message : 'Could not load the tracking report.',
                onRetry: () async => ref.invalidate(_trackingProvider(q)),
              ),
              data: (d) => RefreshIndicator(
                onRefresh: () async => ref.invalidate(_trackingProvider(q)),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32,
                  ),
                  children: [
                    Text('Visits (${d.visits.length})',
                        style: theme.textTheme.titleMedium),
                    const SizedBox(height: AppSpacing.sm8),
                    if (d.visits.isEmpty)
                      Text('No visits logged for this day.',
                          style: theme.textTheme.bodySmall)
                    else
                      for (final v in d.visits) ...[
                        _visitCard(theme, v),
                        const SizedBox(height: AppSpacing.sm8),
                      ],
                    const SizedBox(height: AppSpacing.md12),
                    Text('GPS pings (${d.pings.length})',
                        style: theme.textTheme.titleMedium),
                    const SizedBox(height: AppSpacing.sm8),
                    if (d.pings.isEmpty)
                      Text('No location pings for this day.',
                          style: theme.textTheme.bodySmall)
                    else
                      for (final p in d.pings) ...[
                        _pingCard(theme, p),
                        const SizedBox(height: AppSpacing.sm8),
                      ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _visitCard(ThemeData theme, FieldVisit v) {
    return AppCard(
      onTap: () => _openMap(v.lat, v.lng),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(v.customer ?? '—', style: theme.textTheme.titleMedium),
              ),
              // "within" = the check-in happened inside the customer's geofence.
              Icon(
                v.within ? Icons.gps_fixed : Icons.gps_off,
                size: 16,
                color: v.within ? AppColors.success : AppColors.warn,
              ),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            [
              if (v.salesPerson != null) v.salesPerson!,
              if (v.location != null) v.location!,
            ].join('  •  '),
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 2),
          Text(
            'In ${_fmtStamp(v.checkinAt)}'
            '${v.checkoutAt != null ? '   •   Out ${_fmtStamp(v.checkoutAt)}' : ''}'
            '${v.distanceM != null ? '   •   ${v.distanceM} m away' : ''}',
            style: theme.textTheme.bodySmall,
          ),
          if (v.note != null) ...[
            const SizedBox(height: 2),
            Text(v.note!, style: theme.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }

  Widget _pingCard(ThemeData theme, _Ping p) {
    return AppCard(
      onTap: () => _openMap(p.lat, p.lng),
      child: Row(
        children: [
          const Icon(Icons.my_location, size: 16, color: AppColors.primary),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p.salesPerson ?? '—', style: theme.textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(
                  [
                    _fmtStamp(p.at),
                    if (p.source != null) p.source!,
                    if (p.movedM != null) 'moved ${p.movedM} m',
                  ].join('  •  '),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.text3),
        ],
      ),
    );
  }
}

double? _toDouble(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  return double.tryParse(v.toString());
}

num? _toNum(Object? v) {
  if (v == null) return null;
  if (v is num) return v;
  return num.tryParse(v.toString());
}
