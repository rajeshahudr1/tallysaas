import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/location_helper.dart';
import '../../data/models/gps_config.dart';
import '../../data/repositories/field_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — Part Visit: the salesman picks an assigned beat/area they're visiting;
/// the app captures GPS and logs it (POST /field/part-visits). The assigned
/// beats come from the GPS config (which lists the salesman's sales_person_locations).
class PartVisitScreen extends ConsumerStatefulWidget {
  const PartVisitScreen({super.key});
  @override
  ConsumerState<PartVisitScreen> createState() => _PartVisitScreenState();
}

class _PartVisitScreenState extends ConsumerState<PartVisitScreen> {
  late Future<GpsConfig> _future;
  int? _busyId;

  @override
  void initState() {
    super.initState();
    _future = ref.read(fieldRepositoryProvider).gpsConfig();
  }

  void _reload() => setState(() => _future = ref.read(fieldRepositoryProvider).gpsConfig());

  Future<void> _visit(GpsBeat beat) async {
    if (_busyId != null) return;
    setState(() => _busyId = beat.id);
    try {
      final pos = await LocationHelper.current();
      await ref.read(fieldRepositoryProvider).partVisit(
            locationId: beat.id, lat: pos.latitude, lng: pos.longitude);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('Part visit logged — ${beat.name}'), backgroundColor: AppColors.success));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : e.toString()), backgroundColor: AppColors.danger));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Part Visit')),
      body: FutureBuilder<GpsConfig>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
            return const LoadingState(message: 'Loading your beats…');
          }
          if (snap.hasError && !snap.hasData) {
            return ErrorState('Could not load.', onRetry: _reload);
          }
          final cfg = snap.data!;
          if (!cfg.enabled) {
            return const _Msg('GPS tracking is turned off for your account.');
          }
          if (!cfg.trackPartVisit) {
            return const _Msg('Part-visit capture is turned off by your admin.');
          }
          if (cfg.locations.isEmpty) {
            return const _Msg('No beats/areas assigned to you yet.');
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: AppSpacing.sm8),
                child: Text('Pick the beat/area you are visiting — your GPS is recorded.',
                    style: TextStyle(color: AppColors.text3, fontSize: 12.5)),
              ),
              for (final b in cfg.locations)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                  child: AppCard(
                    child: Row(children: [
                      Container(
                        width: 40, height: 40,
                        decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
                        child: const Icon(Icons.map_outlined, color: AppColors.primary, size: 20),
                      ),
                      const SizedBox(width: AppSpacing.md12),
                      Expanded(child: Text(b.name, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1))),
                      const SizedBox(width: 8),
                      FilledButton.icon(
                        onPressed: _busyId == null ? () => _visit(b) : null,
                        icon: _busyId == b.id
                            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Icon(Icons.my_location, size: 16),
                        label: const Text('Visit'),
                      ),
                    ]),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _Msg extends StatelessWidget {
  const _Msg(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.text3)),
        ),
      );
}
