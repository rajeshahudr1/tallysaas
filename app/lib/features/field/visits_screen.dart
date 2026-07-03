import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/field_dashboard.dart';
import '../../data/repositories/field_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA Phase 2 — the salesman's visit log (their own check-ins). An admin opening
/// this sees the whole company (the API scopes by req.isSalesman).
class VisitsScreen extends ConsumerStatefulWidget {
  const VisitsScreen({super.key});
  @override
  ConsumerState<VisitsScreen> createState() => _VisitsScreenState();
}

class _VisitsScreenState extends ConsumerState<VisitsScreen> {
  late Future<List<FieldVisit>> _future;

  @override
  void initState() {
    super.initState();
    _future = ref.read(fieldRepositoryProvider).visits();
  }

  void _reload() => setState(() => _future = ref.read(fieldRepositoryProvider).visits());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Visit History')),
      body: FutureBuilder<List<FieldVisit>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
            return const LoadingState(message: 'Loading visits…');
          }
          if (snap.hasError && !snap.hasData) {
            return ErrorState('Could not load visits.', onRetry: _reload);
          }
          final rows = snap.data!;
          if (rows.isEmpty) {
            return const Center(child: Text('No visits yet.', style: TextStyle(color: AppColors.text3)));
          }
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(
                  AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              itemCount: rows.length,
              itemBuilder: (context, i) => _tile(rows[i]),
            ),
          );
        },
      ),
    );
  }

  Widget _tile(FieldVisit v) {
    final verified = v.within;
    final c = verified ? AppColors.success : AppColors.warn;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: AppCard(
        child: Row(children: [
          Container(
            width: 40, height: 40,
            decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
            child: Icon(verified ? Icons.check_circle : Icons.location_searching, color: c, size: 20),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(v.customer ?? '—',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
              const SizedBox(height: 2),
              Text([
                Fmt.dateTime(v.checkinAt),
                if (v.location != null) v.location!,
                if (v.salesPerson != null) v.salesPerson!,
              ].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
            ]),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.pill999)),
            child: Text(
              verified
                  ? 'Verified'
                  : v.distanceM != null
                      ? '${v.distanceM} m'
                      : 'No GPS',
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: c),
            ),
          ),
        ]),
      ),
    );
  }
}
