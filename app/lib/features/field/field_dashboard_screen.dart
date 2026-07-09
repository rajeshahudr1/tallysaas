import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../core/utils/location_helper.dart';
import '../../data/models/field_dashboard.dart';
import '../../data/repositories/field_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA — the logged-in salesman's field home: assigned locations (beats) with
/// per-location customer/invoice tallies + an approval-status summary. Mirrors
/// the web `/my-field`. Data from GET /field/my-dashboard.
class FieldDashboardScreen extends ConsumerStatefulWidget {
  const FieldDashboardScreen({super.key});
  @override
  ConsumerState<FieldDashboardScreen> createState() => _FieldDashboardScreenState();
}

class _FieldDashboardScreenState extends ConsumerState<FieldDashboardScreen> {
  late Future<FieldDashboard> _future;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _future = ref.read(fieldRepositoryProvider).myDashboard();
  }

  void _reload() =>
      setState(() => _future = ref.read(fieldRepositoryProvider).myDashboard());

  /// Start / End the day with a GPS punch.
  Future<void> _punch(bool start) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final pos = await LocationHelper.current();
      final repo = ref.read(fieldRepositoryProvider);
      if (start) {
        await repo.startDay(lat: pos.latitude, lng: pos.longitude);
      } else {
        await repo.endDay(lat: pos.latitude, lng: pos.longitude);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(start ? 'Day started.' : 'Day ended.')));
      _reload();
    } on ApiException catch (e) {
      _snack(e.message, err: true);
    } catch (e) {
      _snack(e.toString(), err: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String msg, {bool err = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), backgroundColor: err ? AppColors.danger : null));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My Field')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/sales-invoices/add'),
        icon: const Icon(Icons.add),
        label: const Text('New Invoice'),
      ),
      body: FutureBuilder<FieldDashboard>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
            return const LoadingState(message: 'Loading your field…');
          }
          if (snap.hasError && !snap.hasData) {
            return ErrorState('Could not load your field dashboard.', onRetry: _reload);
          }
          final f = snap.data!;
          if (!f.isSalesman) {
            return const _NotSalesman();
          }
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(
                  AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, 96),
              children: [
                _attendanceCard(f),
                const SizedBox(height: AppSpacing.md12),
                _quickActions(),
                const SizedBox(height: AppSpacing.md12),
                _statGrid(f.stats),
                const SizedBox(height: AppSpacing.md12),
                _approvedValueCard(f.stats),
                const SizedBox(height: AppSpacing.lg16),
                const Text('My Locations',
                    style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1, fontSize: 15)),
                const SizedBox(height: AppSpacing.sm8),
                if (f.locations.isEmpty)
                  const AppCard(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Center(
                        child: Text('No locations assigned yet. Ask your admin to set your beats.',
                            textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)),
                      ),
                    ),
                  )
                else
                  for (final l in f.locations) _locationCard(l),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _statGrid(FieldStats s) => GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: AppSpacing.sm8,
        crossAxisSpacing: AppSpacing.sm8,
        childAspectRatio: 2.5,
        children: [
          _stat('My Locations', Fmt.num0(s.locations), Icons.location_on, AppColors.primary, '/my-locations'),
          _stat('My Customers', Fmt.num0(s.customers), Icons.groups, const Color(0xFF4F46E5), '/my-customers'),
          _stat('Drafts', Fmt.num0(s.draft), Icons.edit_note, AppColors.text3, '/my-approvals?status=draft'),
          _stat('Pending', Fmt.num0(s.pending), Icons.hourglass_bottom, AppColors.warn, '/my-approvals?status=pending'),
          _stat('Approved', Fmt.num0(s.approved), Icons.check_circle, AppColors.success, '/my-approvals?status=approved'),
          _stat('Rejected', Fmt.num0(s.rejected), Icons.cancel, AppColors.danger, '/my-approvals?status=rejected'),
        ],
      );

  // Each stat card links to its detail page (My Locations / My Customers / the
  // status-filtered My Approvals). Refreshes the dashboard when returning.
  Widget _stat(String label, String value, IconData icon, Color c, String route) => InkWell(
        borderRadius: BorderRadius.circular(AppRadius.sm8),
        onTap: () async {
          await context.push(route);
          if (mounted) _reload();
        },
        child: AppCard(
          child: Row(children: [
            Container(
              width: 34, height: 34,
              decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.sm8)),
              child: Icon(icon, color: c, size: 18),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(value, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: AppColors.text1)),
                Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11, color: AppColors.text3, fontWeight: FontWeight.w600)),
              ]),
            ),
            const Icon(Icons.chevron_right, size: 18, color: AppColors.text3),
          ]),
        ),
      );

  Widget _attendanceCard(FieldDashboard f) {
    final att = f.attendance;
    final cov = f.stats.coveragePct;
    return AppCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(att.started ? Icons.timelapse : Icons.wb_sunny_outlined,
              color: AppColors.primary, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              !att.started
                  ? 'Day not started'
                  : att.ended
                      ? 'Day ended'
                      : 'Day in progress',
              style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1),
            ),
          ),
          if (!att.started)
            FilledButton.icon(
              onPressed: _busy ? null : () => _punch(true),
              icon: const Icon(Icons.play_arrow, size: 18),
              label: const Text('Start Day'),
            )
          else if (!att.ended)
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
              onPressed: _busy ? null : () => _punch(false),
              icon: const Icon(Icons.stop, size: 18),
              label: const Text('End Day'),
            ),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          const Text("Today's coverage", style: TextStyle(fontSize: 12.5, color: AppColors.text2)),
          const Spacer(),
          Text('$cov%  ·  ${f.stats.todayVisited}/${f.stats.customers}',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.primary)),
        ]),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.pill999),
          child: LinearProgressIndicator(
            value: (cov / 100).clamp(0.0, 1.0),
            minHeight: 8,
            backgroundColor: const Color(0xFFE2E8F0),
            valueColor: AlwaysStoppedAnimation(cov >= 100 ? AppColors.success : AppColors.primary),
          ),
        ),
      ]),
    );
  }

  Widget _quickActions() => Row(children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: () => context.push('/field/checkin'),
            icon: const Icon(Icons.my_location, size: 17),
            label: const Text('Check In'),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), padding: const EdgeInsets.symmetric(horizontal: 6)),
          ),
        ),
        const SizedBox(width: AppSpacing.xs4),
        Expanded(
          child: OutlinedButton.icon(
            onPressed: () => context.push('/field/part-visit'),
            icon: const Icon(Icons.map_outlined, size: 17),
            label: const Text('Part Visit'),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), padding: const EdgeInsets.symmetric(horizontal: 6)),
          ),
        ),
        const SizedBox(width: AppSpacing.xs4),
        Expanded(
          child: OutlinedButton.icon(
            onPressed: () => context.push('/field/visits'),
            icon: const Icon(Icons.history, size: 17),
            label: const Text('Visits'),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), padding: const EdgeInsets.symmetric(horizontal: 6)),
          ),
        ),
      ]);

  Widget _approvedValueCard(FieldStats s) => AppCard(
        child: Row(children: [
          const Icon(Icons.currency_rupee, color: AppColors.success, size: 20),
          const SizedBox(width: 8),
          const Expanded(
            child: Text('Approved sales value',
                style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.text2)),
          ),
          Text(Fmt.inr(s.approvedValue),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: AppColors.success)),
        ]),
      );

  Widget _locationCard(FieldLocation l) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
    child: AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(l.name, style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: (l.isActive ? AppColors.success : AppColors.text3).withOpacity(0.12),
                borderRadius: BorderRadius.circular(AppRadius.pill999),
              ),
              child: Text(l.status ?? '—',
                  style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700,
                      color: l.isActive ? AppColors.success : AppColors.text3)),
            ),
          ]),
          if (l.place.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(l.place, style: const TextStyle(fontSize: 12, color: AppColors.text3)),
          ],
          const Divider(height: 16),
          Row(children: [
            _metric(Fmt.num0(l.customers), 'Customers'),
            _metric(Fmt.num0(l.invoices), 'My Invoices'),
            _metric(Fmt.inr(l.salesValue), 'Sales'),
          ]),
        ]),
      ),
    );

  Widget _metric(String v, String label) => Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(v, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.text1)),
          Text(label, style: const TextStyle(fontSize: 10.5, color: AppColors.text3, fontWeight: FontWeight.w600)),
        ]),
      );
}

class _NotSalesman extends StatelessWidget {
  const _NotSalesman();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('This page is for field salesmen. Your account is not linked to a salesman profile.',
              textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)),
        ),
      );
}
