import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';

/// One party's follow-up trail — what was SAID, as opposed to what was billed.
///
/// Append-only by design: an activity records something that happened, so
/// there is no edit. A correction is a new entry, which is also how anyone
/// reading the timeline expects it to behave.
class PartyActivityScreen extends ConsumerStatefulWidget {
  const PartyActivityScreen({
    super.key,
    required this.partyId,
    required this.partyName,
    required this.supplier,
  });

  final int partyId;
  final String partyName;
  final bool supplier;

  @override
  ConsumerState<PartyActivityScreen> createState() => _PartyActivityScreenState();
}

class _PartyActivityScreenState extends ConsumerState<PartyActivityScreen> {
  Future<Map<String, dynamic>>? _future;

  String get _type => widget.supplier ? 'supplier' : 'customer';

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await ref
        .read(apiClientProvider)
        .get('/parties/$_type/${widget.partyId}/activities');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  void _refresh() => setState(() => _future = _load());

  /// Outcome → pill colour. The ones that mean "this is going nowhere" read
  /// red; the ones that mean "there is a next step" read blue or green.
  Color _tone(String outcome) {
    switch (outcome) {
      case 'interested':
      case 'payment_promised':
      case 'meeting_scheduled':
        return AppColors.success;
      case 'not_interested':
        return AppColors.danger;
      case 'busy':
      case 'call_back':
        return const Color(0xFFB45309);
      case 'follow_up':
        return AppColors.primary;
      default:
        return AppColors.text3;
    }
  }

  Future<void> _openComposer(List<Map<String, dynamic>> outcomes) async {
    final noteCtl = TextEditingController();
    String outcome = outcomes.isNotEmpty ? '${outcomes.first['value']}' : 'note';
    DateTime? followUp;

    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheetCtx) => Padding(
        padding: EdgeInsets.only(
          left: AppSpacing.md12,
          right: AppSpacing.md12,
          top: AppSpacing.md12,
          bottom: MediaQuery.of(sheetCtx).viewInsets.bottom + AppSpacing.md12,
        ),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Log an activity',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: AppSpacing.md12),
              DropdownButtonFormField<String>(
                value: outcome,
                decoration: const InputDecoration(labelText: 'Outcome', border: OutlineInputBorder()),
                items: [
                  for (final o in outcomes)
                    DropdownMenuItem(value: '${o['value']}', child: Text('${o['label']}')),
                ],
                onChanged: (v) => setSheet(() => outcome = v ?? outcome),
              ),
              const SizedBox(height: AppSpacing.md12),
              TextField(
                controller: noteCtl,
                maxLines: 3,
                maxLength: 2000,
                decoration: const InputDecoration(
                  labelText: 'Note',
                  hintText: 'What was said?',
                  border: OutlineInputBorder(),
                ),
              ),
              // Optional on purpose: plenty of calls need no follow-up, and a
              // made-up date would clutter every reminder list.
              Row(
                children: [
                  Expanded(
                    child: Text(
                      followUp == null
                          ? 'No follow-up date'
                          : 'Follow up on ${Fmt.date(followUp)}',
                      style: const TextStyle(color: AppColors.text2),
                    ),
                  ),
                  TextButton(
                    onPressed: () async {
                      final now = DateTime.now();
                      final picked = await showDatePicker(
                        context: ctx,
                        initialDate: now,
                        firstDate: now.subtract(const Duration(days: 365)),
                        lastDate: now.add(const Duration(days: 365 * 2)),
                      );
                      if (picked != null) setSheet(() => followUp = picked);
                    },
                    child: Text(followUp == null ? 'Pick date' : 'Change'),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm8),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.of(sheetCtx).pop(true),
                  child: const Text('Add Activity'),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    if (saved != true) {
      noteCtl.dispose();
      return;
    }

    final body = <String, dynamic>{'outcome': outcome};
    if (noteCtl.text.trim().isNotEmpty) body['note'] = noteCtl.text.trim();
    if (followUp != null) {
      final d = followUp!;
      body['follow_up_on'] =
          '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    }
    noteCtl.dispose();

    try {
      await ref
          .read(apiClientProvider)
          .post('/parties/$_type/${widget.partyId}/activities', body: body);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Activity logged.')));
      _refresh();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Activity'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh)],
      ),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Could not load activity.', style: TextStyle(color: AppColors.text2)),
                  TextButton(onPressed: _refresh, child: const Text('Retry')),
                ],
              ),
            );
          }
          final body = snap.data ?? const {};
          final rows = (body['data'] as List<dynamic>? ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
          final meta = body['meta'] as Map<String, dynamic>? ?? const {};
          final outcomes = (meta['outcomes'] as List<dynamic>? ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();

          return Scaffold(
            floatingActionButton: FloatingActionButton.extended(
              onPressed: () => _openComposer(outcomes),
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('Log'),
            ),
            body: RefreshIndicator(
              onRefresh: () async => _refresh(),
              child: ListView(
                padding: const EdgeInsets.all(AppSpacing.md12),
                children: [
                  Text(widget.partyName,
                      style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
                  const SizedBox(height: AppSpacing.md12),
                  if (rows.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                      child: Center(
                        child: Text('No activity logged for this party yet.',
                            style: TextStyle(color: AppColors.text3)),
                      ),
                    )
                  else
                    ...rows.map((r) => Padding(
                          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                          child: _activityRow(r),
                        )),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _activityRow(Map<String, dynamic> r) {
    final outcome = '${r['outcome'] ?? ''}';
    final note = '${r['note'] ?? ''}';
    final follow = r['follow_up_on'];
    final by = '${r['by'] ?? ''}';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: _tone(outcome).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text('${r['outcome_label'] ?? outcome}',
                    style: TextStyle(
                        fontSize: 11.5, fontWeight: FontWeight.w700, color: _tone(outcome))),
              ),
              const Spacer(),
              Text(Fmt.dateTime(r['created_at']),
                  style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
            ],
          ),
          if (note.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(note, style: const TextStyle(fontSize: 13.5, color: AppColors.text1)),
          ],
          if (follow != null) ...[
            const SizedBox(height: 6),
            Text('Follow up on ${Fmt.date(follow)}',
                style: const TextStyle(fontSize: 12, color: AppColors.primary)),
          ],
          if (by.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('by $by', style: const TextStyle(fontSize: 11.5, color: AppColors.text3)),
          ],
        ],
      ),
    );
  }
}
