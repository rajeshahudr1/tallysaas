import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/tally_ledger.dart';
import '../../data/repositories/tally_ledger_repository.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// One ledger's statement for a period: the opening / closing pair Tally
/// prints, the voucher-type chips, and the vouchers that moved the balance.
/// Reached from the Cash / Bank / Payables / Receivables lists.
class LedgerStatementScreen extends ConsumerStatefulWidget {
  const LedgerStatementScreen({
    super.key,
    required this.ledgerName,
    required this.from,
    required this.to,
  });

  final String ledgerName;
  final String from;
  final String to;

  @override
  ConsumerState<LedgerStatementScreen> createState() => _LedgerStatementScreenState();
}

class _LedgerStatementScreenState extends ConsumerState<LedgerStatementScreen> {
  LedgerStatement? _stmt;
  String? _error;
  String? _voucherType;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final s = await ref.read(tallyLedgerRepositoryProvider).statement(
            widget.ledgerName,
            from: widget.from,
            to: widget.to,
            voucherType: _voucherType,
          );
      if (mounted) setState(() => _stmt = s);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this ledger.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_stmt?.name ?? widget.ledgerName)),
      body: _body(),
    );
  }

  Widget _body() {
    if (_error != null) return ErrorState(_error!, onRetry: _load);
    final s = _stmt;
    if (s == null) return const LoadingState(message: 'Loading ledger…');

    final theme = Theme.of(context);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32,
        ),
        children: [
          // Opening / closing on the brand wash — the pair Tally leads with.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.lg16),
            decoration: BoxDecoration(
              gradient: AppGradients.header,
              borderRadius: BorderRadius.circular(AppRadius.lg16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.name, style: theme.textTheme.titleLarge),
                if (s.parent != null) ...[
                  const SizedBox(height: 2),
                  Text(s.parent!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: AppSpacing.md12),
                Row(
                  children: [
                    Expanded(
                      child: _balance(theme, 'Opening', s.openingAmount, s.openingDc),
                    ),
                    Expanded(
                      child: _balance(theme, 'Closing', s.closingAmount, s.closingDc),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.sm8),
                Text(
                  'Debit ${Fmt.inr(s.debit ?? 0)}   •   Credit ${Fmt.inr(s.credit ?? 0)}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),

          if (s.voucherTypes.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md12),
            SizedBox(
              height: 40,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  _typeChip('All', null),
                  for (final t in s.voucherTypes) _typeChip(t, t),
                ],
              ),
            ),
          ],

          // Ledger contact / bank details, hidden row-by-row when blank.
          const DetailSection('Ledger'),
          AppCard(
            child: Column(
              children: [
                DetailRow('GSTIN', s.gstin),
                DetailRow('State', s.state),
                DetailRow('Address', s.address),
                DetailRow('Contact', s.contact),
                DetailRow('Email', s.email),
                DetailRow('Bank', s.bankName),
                DetailRow('A/c No', s.bankAccNo),
                DetailRow('IFSC', s.ifsc),
              ],
            ),
          ),

          DetailSection('Vouchers (${s.total})'),
          if (s.rows.isEmpty)
            const Text('No vouchers in this period.')
          else
            for (final e in s.rows) ...[
              _entryCard(theme, e),
              const SizedBox(height: AppSpacing.sm8),
            ],
          if (s.hasMore)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm8),
              child: Text(
                'Showing the first ${s.rows.length} of ${s.total} — narrow the date '
                'range or pick a voucher type to see the rest.',
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
              ),
            ),
        ],
      ),
    );
  }

  Widget _balance(ThemeData theme, String label, num? amount, String? dc) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: theme.textTheme.bodySmall),
        const SizedBox(height: 2),
        Text(
          '${Fmt.inr(amount ?? 0)}${dc == null ? '' : ' $dc'}',
          style: theme.textTheme.titleMedium,
        ),
      ],
    );
  }

  Widget _typeChip(String label, String? value) {
    final selected = _voucherType == value;
    return Padding(
      padding: const EdgeInsets.only(right: AppSpacing.sm8),
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) {
          setState(() => _voucherType = value);
          _load();
        },
        selectedColor: AppColors.primaryTint,
        labelStyle: TextStyle(
          color: selected ? AppColors.primary : AppColors.text2,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
        ),
      ),
    );
  }

  Widget _entryCard(ThemeData theme, LedgerEntry e) {
    final date = e.voucherDate == null ? null : DateTime.tryParse(e.voucherDate!);
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(e.voucherNo ?? e.voucherType ?? '—',
                    style: theme.textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(
                  [
                    if (e.voucherType != null) e.voucherType!,
                    if (date != null) Fmt.date(date),
                  ].join('  •  '),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(Fmt.inr(e.amount ?? 0), style: theme.textTheme.titleSmall),
              const SizedBox(height: 2),
              Text(
                e.dc ?? '',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: e.isDebit ? AppColors.success : AppColors.danger,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
