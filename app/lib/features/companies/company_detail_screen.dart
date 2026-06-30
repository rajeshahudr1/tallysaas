import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/company.dart';
import '../../data/repositories/company_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Company detail (View) via the shared [DetailScaffold] — Edit/Delete gated by
/// `companies.edit` / `companies.delete`.
class CompanyDetailScreen extends ConsumerWidget {
  const CompanyDetailScreen({super.key, required this.companyId});
  final int companyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(companyRepositoryProvider);
    return DetailScaffold<Company>(
      title: 'Company',
      module: 'companies',
      load: () => repo.get(companyId),
      onDelete: () => repo.delete(companyId),
      editRoute: '/companies/$companyId/edit',
      deleteTitle: 'Delete company?',
      deleteMessage: 'This company will be removed from the cloud.',
      deletedMessage: 'Company deleted.',
      bodyBuilder: (context, c) => [
        DetailHeader(c.name, trailing: c.status != null ? StatusPill(c.status!) : null),
        const DetailSection('Basic Information', first: true),
        DetailRow('Mailing Name', c.mailingName),
        DetailRow('Email', c.email),
        DetailRow('Mobile', c.mobile),
        DetailRow('Phone', c.phone),
        const DetailSection('Address'),
        DetailRow('Address', c.address),
        DetailRow('State', c.state),
        DetailRow('Pincode', c.pincode),
        DetailRow('Country', c.country),
        const DetailSection('Tax & Statutory'),
        DetailRow('GST Number', c.gstNumber),
        DetailRow('PAN Number', c.panNumber),
        const DetailSection('Financial Year'),
        DetailRow('Financial Year', c.financialYear),
        DetailRow('Books From', c.booksFrom),
        if (c.customFields.isNotEmpty) ...[
          const DetailSection('Custom Fields'),
          for (final e in c.customFields.entries) DetailRow(e.key, e.value?.toString()),
        ],
      ],
    );
  }
}
