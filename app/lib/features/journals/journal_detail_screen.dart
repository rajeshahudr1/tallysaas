import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart' show invoiceStatusLabel;
import '../../data/models/journal.dart';
import '../../data/repositories/journal_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Journal / Contra detail (View) via the shared [DetailScaffold] — NO Edit
/// (these vouchers aren't edited), Delete gated by `<module>.delete`. The
/// [scope] picks which endpoint + permission slug applies.
class JournalDetailScreen extends ConsumerWidget {
  const JournalDetailScreen({
    super.key,
    required this.journalId,
    this.scope = JournalScope.journals,
  });
  final int journalId;
  final JournalScope scope;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(journalRepositoryProvider(scope));
    final noun = scope.singular.toLowerCase();
    return DetailScaffold<Journal>(
      title: scope.singular,
      module: scope.module,
      load: () => repo.get(journalId),
      onDelete: () => repo.delete(journalId),
      deleteTitle: 'Delete $noun?',
      deleteMessage: 'This $noun voucher will be removed. You can re-sync it from Tally later.',
      deletedMessage: '${scope.singular} deleted.',
      bodyBuilder: (context, j) => [
        DetailHeader(
          j.voucherNo,
          trailing: j.status != null ? StatusPill(invoiceStatusLabel(j.status)) : null,
        ),
        const DetailSection('Details', first: true),
        DetailRow('Type', j.vchType),
        DetailRow('Date', j.journalDate == null ? null : Fmt.date(j.journalDate)),
        DetailRow('Debit (Dr)', j.drLedger),
        DetailRow('Credit (Cr)', j.crLedger),
        DetailRow('Amount', j.amount == null ? null : Fmt.inr(j.amount)),
        DetailRow('Narration', j.narration),
      ],
    );
  }
}
