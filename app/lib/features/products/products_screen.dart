import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/utils/formatters.dart';
import '../../data/models/product.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/advanced_filter.dart';
import '../../shared/widgets/loading_state.dart';
import '../../shared/widgets/image_viewer.dart';
import '../../shared/widgets/status_pill.dart';
import 'products_controller.dart';

/// Products master — searchable, paginated list with pull-to-refresh, infinite
/// scroll, and a + button to add. Data from `GET /products` (company-scoped via
/// the X-Company-Id header). Mirrors the Customers screen.
class ProductsScreen extends ConsumerStatefulWidget {
  const ProductsScreen({super.key});

  @override
  ConsumerState<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends ConsumerState<ProductsScreen> {
  final _searchCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _scrollCtl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtl.dispose();
    _scrollCtl.removeListener(_onScroll);
    _scrollCtl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtl.position.pixels >=
        _scrollCtl.position.maxScrollExtent - 240) {
      ref.read(productsControllerProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(productsControllerProvider.notifier).search(q);
    });
  }

  static const _fields = [
    FilterField('status', 'Status', FType.select,
        options: ['Active', 'Inactive']),
    FilterField('created_from', 'Created From', FType.dateFrom),
    FilterField('created_to', 'Created To', FType.dateTo),
  ];

  Future<void> _openFilter() async {
    final ctrl = ref.read(productsControllerProvider.notifier);
    final res = await showAdvancedFilter(context, ref,
        title: 'Products filter', fields: _fields, current: ctrl.adv);
    if (res != null) ctrl.setAdvFilter(res);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(productsControllerProvider);
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    final canCreate = user?.can('products', 'create') ?? false;
    final hasFilter =
        ref.read(productsControllerProvider.notifier).adv.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Products'),
        actions: [
          IconButton(
            icon: Icon(hasFilter ? Icons.filter_alt : Icons.tune),
            color: hasFilter ? AppColors.primary : null,
            tooltip: 'Filter',
            onPressed: _openFilter,
          ),
        ],
      ),
      floatingActionButton: !canCreate
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                final created = await context.push<bool>('/products/add');
                if (created == true) {
                  ref.read(productsControllerProvider.notifier).refresh();
                }
              },
              icon: const Icon(Icons.add),
              label: const Text('Add'),
            ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md12),
            child: AppTextField(
              controller: _searchCtl,
              hint: 'Search by name, SKU, HSN…',
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body(state)),
        ],
      ),
    );
  }

  Widget _body(ProductsState state) {
    switch (state) {
      case ProductsLoading():
        return const LoadingState(message: 'Loading products…');
      case ProductsError(:final message):
        return ErrorState(
          message,
          onRetry: () =>
              ref.read(productsControllerProvider.notifier).refresh(),
        );
      case ProductsReady(:final items, :final hasMore, :final loadingMore):
        if (items.isEmpty) {
          return const EmptyState('No products found.',
              icon: Icons.inventory_2_outlined);
        }
        return RefreshIndicator(
          onRefresh: () =>
              ref.read(productsControllerProvider.notifier).refresh(),
          child: ListView.separated(
            controller: _scrollCtl,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12,
              0,
              AppSpacing.md12,
              AppSpacing.xxl32,
            ),
            itemCount: items.length + (hasMore ? 1 : 0),
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
            itemBuilder: (context, i) {
              if (i >= items.length) {
                return Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg16),
                  child: Center(
                    child: loadingMore
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : const SizedBox.shrink(),
                  ),
                );
              }
              final p = items[i];
              return _ProductCard(
                p,
                onTap: () async {
                  await context.push('/products/${p.id}');
                  if (context.mounted) {
                    ref.read(productsControllerProvider.notifier).refresh();
                  }
                },
              );
            },
          ),
        );
    }
  }
}

class _ProductCard extends StatelessWidget {
  const _ProductCard(this.p, {this.onTap});
  final Product p;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bits = <String>[
      if (p.category != null) p.category!,
      if (p.unit != null) p.unit!,
    ];
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          _thumb(context, p),
          const SizedBox(width: AppSpacing.md12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p.name, style: theme.textTheme.titleMedium),
                if (bits.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(bits.join(' · '), style: theme.textTheme.bodySmall),
                ],
                if (p.gstRate != null) ...[
                  const SizedBox(height: 2),
                  Text('GST ${Fmt.num0(p.gstRate)}%',
                      style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (p.salesPrice != null)
                Text(Fmt.inr(p.salesPrice), style: theme.textTheme.titleSmall),
              if (p.openingStock != null) ...[
                const SizedBox(height: 4),
                Text('Stock ${Fmt.num0(p.openingStock)}',
                    style: theme.textTheme.bodySmall),
              ],
              if (p.status != null) ...[
                const SizedBox(height: 6),
                StatusPill(p.status!),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _thumb(BuildContext context, Product p) {
    final url = p.imageUrl;
    final gallery = p.images.map((im) => im.url).toList();
    final img = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: (url == null || url.isEmpty)
          ? Container(
              width: 44,
              height: 44,
              color: Colors.black12,
              child: const Icon(Icons.image_outlined,
                  size: 20, color: Colors.black26),
            )
          : Image.network(
              url,
              width: 44,
              height: 44,
              fit: BoxFit.cover,
              errorBuilder: (c, e, s) => Container(
                width: 44,
                height: 44,
                color: Colors.black12,
                child: const Icon(Icons.broken_image_outlined, size: 20),
              ),
            ),
    );
    if (gallery.isEmpty) return img;
    // Tapping the thumbnail opens the full gallery (card tap still opens detail).
    return GestureDetector(
      onTap: () => showImageGallery(context, gallery, title: p.name),
      child: img,
    );
  }
}
