import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/location.dart';
import '../../data/repositories/location_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Location detail (View) via the shared [DetailScaffold] — Edit/Delete gated by
/// `locations.edit` / `locations.delete`.
class LocationDetailScreen extends ConsumerWidget {
  const LocationDetailScreen({super.key, required this.locationId});
  final int locationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(locationRepositoryProvider);
    return DetailScaffold<Location>(
      title: 'Location',
      module: 'locations',
      load: () => repo.get(locationId),
      onDelete: () => repo.delete(locationId),
      editRoute: '/locations/$locationId/edit',
      deleteTitle: 'Delete location?',
      deleteMessage: 'This location will be removed. You can re-sync it from Tally later.',
      deletedMessage: 'Location deleted.',
      bodyBuilder: (context, l) => [
        DetailHeader(l.name, trailing: l.status != null ? StatusPill(l.status!) : null),
        const DetailSection('Basic Information', first: true),
        DetailRow('Code', l.code),
        DetailRow('Tally Godown', l.isTallyGodown == null ? null : (l.isTallyGodown! ? 'Yes' : 'No')),
        const DetailSection('Address'),
        DetailRow('City', l.city),
        DetailRow('State', l.state),
        DetailRow('Pincode', l.pincode),
        const DetailSection('Contact & Manager'),
        DetailRow('Mobile', l.mobile),
        DetailRow('Manager', l.manager),
        if (l.customFields.isNotEmpty) ...[
          const DetailSection('Custom Fields'),
          for (final e in l.customFields.entries) DetailRow(e.key, e.value?.toString()),
        ],
      ],
    );
  }
}
