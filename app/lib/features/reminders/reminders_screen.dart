import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Payment Reminders — overdue customers (past-due sales invoice + positive
/// outstanding) with a one-tap Email / WhatsApp nudge. The channels a company
/// may use are gated by the licence's Super-Admin switches (returned in the
/// payload). Mirrors the web page exactly.
final _remindersProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final data = await ref.read(apiClientProvider).get('/account/reminders');
  return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
});

const _kGreen = Color(0xFF16A34A);
const _kOrange = Color(0xFFEA580C);
const _kWarn = Color(0xFFB45309);

class RemindersScreen extends ConsumerWidget {
  const RemindersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_remindersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Payment Reminders'), actions: const [ModuleInfoButton('reminders')]),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load reminders.',
          onRetry: () => ref.invalidate(_remindersProvider),
        ),
        data: (d) {
          final list = (d['data'] as List?)
                  ?.whereType<Map>()
                  .map((m) => m.cast<String, dynamic>())
                  .toList() ??
              const <Map<String, dynamic>>[];
          final ch = (d['channels'] as Map?)?.cast<String, dynamic>() ?? const {};
          final total = Fmt.n(d['total_outstanding']);
          final emailOn = ch['email'] == true;
          final waOn = ch['whatsapp'] == true;
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_remindersProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              children: [
                _SummaryCard(count: list.length, total: total, emailOn: emailOn, waOn: waOn),
                const SizedBox(height: AppSpacing.md12),
                if (list.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: AppSpacing.xxl32),
                    child: Center(
                      child: Text('No overdue customers — all caught up! 🎉',
                          textAlign: TextAlign.center, style: TextStyle(color: AppColors.text3)),
                    ),
                  )
                else
                  ...list.map((c) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _CustomerCard(c,
                            emailOn: emailOn, waOn: waOn,
                            onSend: (channel) => _send(context, ref, c, channel)),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _send(BuildContext context, WidgetRef ref, Map<String, dynamic> c, String channel) async {
    try {
      await ref.read(apiClientProvider).post('/account/reminders/${c['id']}/send', body: {'channel': channel});
      ref.invalidate(_remindersProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Reminder sent to ${c['name'] ?? 'customer'} via ${channel == 'email' ? 'Email' : 'WhatsApp'}.')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e is ApiException ? e.message : 'Could not send: $e')));
      }
    }
  }
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.count, required this.total, required this.emailOn, required this.waOn});
  final int count;
  final num total;
  final bool emailOn;
  final bool waOn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: _metric(theme, 'Overdue customers', '$count', false)),
              Expanded(child: _metric(theme, 'Total outstanding', Fmt.inr(total), true)),
            ],
          ),
          const SizedBox(height: AppSpacing.md12),
          Wrap(spacing: 8, runSpacing: 6, children: [
            _chip('Email', emailOn, Icons.email_outlined),
            _chip('WhatsApp', waOn, Icons.chat_bubble_outline),
          ]),
          if (!emailOn && !waOn)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm8),
              child: Text('No reminder channel is enabled for your plan. Ask your administrator.',
                  style: theme.textTheme.bodySmall?.copyWith(color: _kWarn)),
            ),
        ],
      ),
    );
  }

  Widget _metric(ThemeData t, String label, String val, bool danger) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: t.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
          const SizedBox(height: 2),
          Text(val, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: danger ? AppColors.danger : AppColors.text1)),
        ],
      );

  Widget _chip(String label, bool on, IconData icon) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: (on ? _kGreen : AppColors.text3).withOpacity(0.12),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 13, color: on ? _kGreen : AppColors.text3),
          const SizedBox(width: 5),
          Text('$label ${on ? 'On' : 'Off'}',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: on ? _kGreen : AppColors.text3)),
        ]),
      );
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard(this.c, {required this.emailOn, required this.waOn, required this.onSend});
  final Map<String, dynamic> c;
  final bool emailOn;
  final bool waOn;
  final void Function(String channel) onSend;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = '${c['name'] ?? ''}';
    final email = '${c['email'] ?? ''}';
    final mobile = '${c['mobile'] ?? ''}';
    final outstanding = Fmt.n(c['outstanding']);
    final overdueCount = Fmt.n(c['overdue_count']).toInt();
    final days = Fmt.n(c['days_overdue']).toInt();
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 18,
                backgroundColor: AppColors.primary,
                child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: AppSpacing.md12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: theme.textTheme.titleMedium),
                    if (email.isNotEmpty) Text(email, style: theme.textTheme.bodySmall),
                    if (mobile.isNotEmpty)
                      Text(mobile, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(Fmt.inr(outstanding),
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: AppColors.danger)),
                  Container(
                    margin: const EdgeInsets.only(top: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(color: _kOrange.withOpacity(0.10), borderRadius: BorderRadius.circular(999)),
                    child: Text('$overdueCount inv · ${days}d',
                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: _kOrange)),
                  ),
                ],
              ),
            ],
          ),
          if (emailOn || waOn) ...[
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                if (emailOn)
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: email.isNotEmpty ? () => onSend('email') : null,
                      icon: const Icon(Icons.email_outlined, size: 16),
                      label: const Text('Email'),
                      style: OutlinedButton.styleFrom(foregroundColor: AppColors.primary),
                    ),
                  ),
                if (emailOn && waOn) const SizedBox(width: AppSpacing.sm8),
                if (waOn)
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: mobile.isNotEmpty ? () => onSend('whatsapp') : null,
                      icon: const Icon(Icons.chat_bubble_outline, size: 16),
                      label: const Text('WhatsApp'),
                      style: OutlinedButton.styleFrom(foregroundColor: _kGreen),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
