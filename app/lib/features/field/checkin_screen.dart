import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/utils/location_helper.dart';
import '../../data/models/customer.dart';
import '../../data/models/paged.dart';
import '../../data/repositories/customer_repository.dart';
import '../../data/repositories/field_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// SFA Phase 2 — the salesman picks an outlet and CHECKS IN. The app captures
/// GPS and the server flags whether it was inside the outlet's geofence.
class CheckinScreen extends ConsumerStatefulWidget {
  const CheckinScreen({super.key});
  @override
  ConsumerState<CheckinScreen> createState() => _CheckinScreenState();
}

class _CheckinScreenState extends ConsumerState<CheckinScreen> {
  late Future<PagedResult<Customer>> _future;
  final _search = TextEditingController();
  Timer? _debounce;
  int? _busyId; // customer id currently checking in

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<PagedResult<Customer>> _load() =>
      ref.read(customerRepositoryProvider).list(perPage: 50, search: _search.text);

  void _reload() => setState(() => _future = _load());

  void _onSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _reload);
  }

  /// Ask the salesman what they did at this outlet. Returns the comment (may be
  /// empty), or null if they cancelled the whole check-in.
  Future<String?> _askComment(Customer c) {
    final ctl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Check in — ${c.name}', maxLines: 2, overflow: TextOverflow.ellipsis),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('What did you do at this shop?',
                style: TextStyle(color: AppColors.text2, fontSize: 13)),
            const SizedBox(height: AppSpacing.sm8),
            TextField(
              controller: ctl,
              autofocus: true,
              minLines: 2,
              maxLines: 4,
              maxLength: 500,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                hintText: 'e.g. Took order, collected payment, shared new catalogue…',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton.icon(
            onPressed: () => Navigator.pop(ctx, ctl.text.trim()),
            icon: const Icon(Icons.my_location, size: 16),
            label: const Text('Check In'),
          ),
        ],
      ),
    );
  }

  Future<void> _checkin(Customer c) async {
    if (_busyId != null) return;
    final note = await _askComment(c);
    if (note == null) return; // cancelled
    if (!mounted) return;
    setState(() => _busyId = c.id);
    try {
      final pos = await LocationHelper.current();
      final row = await ref.read(fieldRepositoryProvider).checkin(
            customerId: c.id,
            lat: pos.latitude,
            lng: pos.longitude,
            note: note,
          );
      if (!mounted) return;
      final within = row['checkin_within'] == true;
      final dist = row['checkin_distance_m'];
      final msg = within
          ? 'Checked in — location verified${dist != null ? ' ($dist m)' : ''}.'
          : dist != null
              ? 'Checked in — but you appear $dist m from the outlet.'
              : 'Checked in.';
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: within ? AppColors.success : AppColors.warn,
        ));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.toString()), backgroundColor: AppColors.danger));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Check In at Outlet')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(AppSpacing.md12),
          child: TextField(
            controller: _search,
            onChanged: _onSearch,
            decoration: InputDecoration(
              hintText: 'Search customer…',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md12)),
              isDense: true,
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<PagedResult<Customer>>(
            future: _future,
            builder: (context, snap) {
              if (snap.connectionState == ConnectionState.waiting && !snap.hasData) {
                return const LoadingState(message: 'Loading outlets…');
              }
              if (snap.hasError && !snap.hasData) {
                return ErrorState('Could not load customers.', onRetry: _reload);
              }
              final rows = snap.data!.items;
              if (rows.isEmpty) {
                return const Center(child: Text('No customers found.', style: TextStyle(color: AppColors.text3)));
              }
              return ListView.builder(
                padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32),
                itemCount: rows.length,
                itemBuilder: (context, i) => _tile(rows[i]),
              );
            },
          ),
        ),
      ]),
    );
  }

  Widget _tile(Customer c) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
        child: AppCard(
          child: Row(children: [
            Container(
              width: 40, height: 40,
              decoration: BoxDecoration(
                color: AppColors.primary.withOpacity(0.12),
                borderRadius: BorderRadius.circular(AppRadius.sm8),
              ),
              child: const Icon(Icons.storefront, color: AppColors.primary, size: 20),
            ),
            const SizedBox(width: AppSpacing.md12),
            Expanded(
              child: Text(c.name,
                  maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.text1)),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: _busyId == null ? () => _checkin(c) : null,
              icon: _busyId == c.id
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.my_location, size: 16),
              label: const Text('Check In'),
            ),
          ]),
        ),
      );
}
