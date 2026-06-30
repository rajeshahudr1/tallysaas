import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/category.dart';
import '../../data/repositories/category_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Category detail (View) via the shared [DetailScaffold] — Edit/Delete gated by
/// `categories.edit` / `categories.delete`.
class CategoryDetailScreen extends ConsumerWidget {
  const CategoryDetailScreen({super.key, required this.categoryId});
  final int categoryId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(categoryRepositoryProvider);
    return DetailScaffold<Category>(
      title: 'Category',
      module: 'categories',
      load: () => repo.get(categoryId),
      onDelete: () => repo.delete(categoryId),
      editRoute: '/categories/$categoryId/edit',
      deleteTitle: 'Delete category?',
      deleteMessage: 'This category will be removed. You can re-sync it from Tally later.',
      deletedMessage: 'Category deleted.',
      bodyBuilder: (context, c) => [
        DetailHeader(c.name, trailing: c.status != null ? StatusPill(c.status!) : null),
        const DetailSection('Details', first: true),
        DetailRow('Parent Category', c.parent ?? 'None (top-level)'),
        DetailRow('Status', c.status),
      ],
    );
  }
}
