import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/formatters.dart';
import '../../data/models/invoice.dart' show invoiceStatusLabel;
import '../../data/models/payment.dart';
import '../../data/repositories/payment_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Voucher detail (View) — shared by Payments + Receipts via [basePath]/[module]/
/// [title]. Shared [DetailScaffold]: NO Edit (vouchers aren't edited), Delete
/// gated by `<module>.delete`.
class VoucherDetailScreen extends ConsumerWidget {
  const VoucherDetailScreen({
    super.key,
    required this.basePath,
    required this.module,
    required this.title,
    required this.voucherId,
  });

  final String basePath; // '/payments' | '/receipts'
  final String module;   // 'payments' | 'receipts'
  final String title;    // 'Payment' | 'Receipt'
  final int voucherId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(paymentRepositoryProvider);
    return DetailScaffold<Payment>(
      title: title,
      module: module,
      load: () => repo.get(basePath, voucherId),
      onDelete: () => repo.delete(basePath, voucherId),
      deleteTitle: 'Delete $title?',
      deleteMessage: 'This voucher will be removed. You can re-sync it from Tally later.',
      deletedMessage: '$title deleted.',
      bodyBuilder: (context, v) => [
        DetailHeader(
          v.party ?? v.voucherNo,
          trailing: v.status != null ? StatusPill(invoiceStatusLabel(v.status)) : null,
        ),
        const DetailSection('Details', first: true),
        DetailRow('Voucher No', v.voucherNo),
        DetailRow('Party', v.party),
        DetailRow('Date', v.paymentDate == null ? null : Fmt.date(v.paymentDate)),
        DetailRow('Mode', v.mode),
        DetailRow('Amount', v.amount == null ? null : Fmt.inr(v.amount)),
        DetailRow('Reference', v.reference),
        DetailRow('Bank Account', v.bankAccount),
        DetailRow('Notes', v.notes),
      ],
    );
  }
}
