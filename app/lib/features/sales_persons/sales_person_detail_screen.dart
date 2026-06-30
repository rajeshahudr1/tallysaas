import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../data/models/sales_person.dart';
import '../../data/repositories/sales_person_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Sales Person detail (View) via the shared [DetailScaffold] — Edit/Delete
/// gated by `sales-persons.edit` / `sales-persons.delete`.
class SalesPersonDetailScreen extends ConsumerWidget {
  const SalesPersonDetailScreen({super.key, required this.salesPersonId});
  final int salesPersonId;

  static String? _fmtDate(String? iso) {
    if (iso == null || iso.trim().isEmpty) return null;
    final d = DateTime.tryParse(iso);
    return d == null ? iso : DateFormat('dd/MM/yyyy').format(d);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(salesPersonRepositoryProvider);
    return DetailScaffold<SalesPerson>(
      title: 'Sales Person',
      module: 'sales-persons',
      load: () => repo.get(salesPersonId),
      onDelete: () => repo.delete(salesPersonId),
      editRoute: '/sales-persons/$salesPersonId/edit',
      deleteTitle: 'Delete sales person?',
      deleteMessage: 'This sales person will be removed.',
      deletedMessage: 'Sales person deleted.',
      bodyBuilder: (context, sp) => [
        DetailHeader(sp.name, trailing: sp.status != null ? StatusPill(sp.status!) : null),
        const DetailSection('Details', first: true),
        DetailRow('Employee Code', sp.employeeCode),
        DetailRow('Mobile', sp.mobile),
        DetailRow('Email', sp.email),
        DetailRow('Joining Date', _fmtDate(sp.joiningDate)),
        DetailRow('Status', sp.status),
      ],
    );
  }
}
