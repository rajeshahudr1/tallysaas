import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/utils/formatters.dart';
import '../../core/utils/launchers.dart';
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
    final note = v.note;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.md12),
        onTap: () => _openDetail(v),
        child: AppCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
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
            if (note != null && note.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpacing.sm8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.05),
                  borderRadius: BorderRadius.circular(AppRadius.sm8),
                ),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Icon(Icons.chat_bubble_outline, size: 14, color: AppColors.text3),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(note,
                        maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: AppColors.text2)),
                  ),
                ]),
              ),
            ],
          ]),
        ),
      ),
    );
  }

  void _openDetail(FieldVisit v) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _VisitDetailSheet(v),
    );
  }
}

/// Full detail of one visit — who / where / when / GPS + the comment the
/// salesman left about what they did. The admin's "what did they do" view.
class _VisitDetailSheet extends StatelessWidget {
  const _VisitDetailSheet(this.v);
  final FieldVisit v;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final verified = v.within;
    final c = verified ? AppColors.success : AppColors.warn;
    Widget row(IconData ic, String label, String? value, {VoidCallback? onTap}) {
      if (value == null || value.trim().isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.md12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(ic, size: 18, color: AppColors.text3),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
              const SizedBox(height: 1),
              Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            ]),
          ),
          if (onTap != null)
            IconButton(icon: const Icon(Icons.open_in_new, size: 18, color: AppColors.primary), onPressed: onTap),
        ]),
      );
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16,
          AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(v.customer ?? 'Visit', style: theme.textTheme.titleMedium)),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(999)),
              child: Text(verified ? 'Verified' : (v.distanceM != null ? '${v.distanceM} m away' : 'No GPS'),
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c)),
            ),
          ]),
          const Divider(height: 20),
          row(Icons.person_outline, 'Salesman', v.salesPerson),
          row(Icons.storefront_outlined, 'Customer', v.customer),
          row(Icons.phone_outlined, 'Mobile', v.customerMobile,
              onTap: v.customerMobile != null ? () => Launch.call(v.customerMobile) : null),
          row(Icons.place_outlined, 'Location', v.location),
          row(Icons.login, 'Checked in', Fmt.dateTime(v.checkinAt)),
          if (v.checkoutAt != null) row(Icons.logout, 'Checked out', Fmt.dateTime(v.checkoutAt)),
          if (v.lat != null && v.lng != null)
            row(Icons.map_outlined, 'GPS', '${v.lat!.toStringAsFixed(5)}, ${v.lng!.toStringAsFixed(5)}',
                onTap: () => Launch.map(v.lat, v.lng)),
          const SizedBox(height: 4),
          Text('What was done at this shop', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.md12),
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.05),
              borderRadius: BorderRadius.circular(AppRadius.sm8),
            ),
            child: Text(
              (v.note != null && v.note!.isNotEmpty) ? v.note! : 'No comment left for this visit.',
              style: TextStyle(
                  fontSize: 13.5,
                  color: (v.note != null && v.note!.isNotEmpty) ? AppColors.text1 : AppColors.text3,
                  fontStyle: (v.note != null && v.note!.isNotEmpty) ? FontStyle.normal : FontStyle.italic),
            ),
          ),
          const SizedBox(height: AppSpacing.md12),
        ]),
      ),
    );
  }
}
