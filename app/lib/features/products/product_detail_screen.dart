import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/formatters.dart';
import '../../data/models/product.dart';
import '../../data/repositories/product_repository.dart';
import '../../shared/widgets/detail_view.dart';
import '../../shared/widgets/status_pill.dart';

/// Product detail (View) — read-only mirror of the form, via the shared
/// [DetailScaffold] (RBAC-gated Edit/Delete on `products.edit`/`products.delete`).
class ProductDetailScreen extends ConsumerWidget {
  const ProductDetailScreen({super.key, required this.productId});
  final int productId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(productRepositoryProvider);
    return DetailScaffold<Product>(
      title: 'Product',
      module: 'products',
      load: () => repo.get(productId),
      onDelete: () => repo.delete(productId),
      editRoute: '/products/$productId/edit',
      deleteTitle: 'Delete product?',
      deleteMessage: 'This product will be removed. You can re-sync it from Tally later.',
      deletedMessage: 'Product deleted.',
      bodyBuilder: (context, p) => [
        DetailHeader(p.name, trailing: p.status != null ? StatusPill(p.status!) : null),
        const DetailSection('Basic Information', first: true),
        DetailRow('SKU', p.sku),
        DetailRow('Category', p.category),
        DetailRow('Unit', p.unit),
        DetailRow('Tally Item', p.isTallyItem == null ? null : (p.isTallyItem! ? 'Yes' : 'No')),
        DetailRow('Description', p.description),
        const DetailSection('Pricing & Tax'),
        DetailRow('HSN / SAC', p.hsnCode),
        DetailRow('GST Rate', p.gstRateLabel),
        DetailRow('Purchase Price', p.purchasePrice == null ? null : Fmt.inr(p.purchasePrice)),
        DetailRow('Sales Price', p.salesPrice == null ? null : Fmt.inr(p.salesPrice)),
        const DetailSection('Stock & Inventory'),
        DetailRow('Opening Stock', p.openingStock?.toString()),
        if (p.customFields.isNotEmpty) ...[
          const DetailSection('Custom Fields'),
          for (final e in p.customFields.entries) DetailRow(e.key, e.value?.toString()),
        ],
      ],
    );
  }
}
