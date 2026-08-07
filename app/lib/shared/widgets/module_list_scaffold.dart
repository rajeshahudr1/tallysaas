import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/module_info.dart';
import 'app_text_field.dart';
import 'empty_state.dart';
import 'error_state.dart';
import 'loading_state.dart';

/// One horizontal quick-filter chip — the mobile form of a web list tab.
class QuickFilter {
  const QuickFilter(this.value, this.label);
  final String value;
  final String label;
}

/// The standard mobile list screen every module uses: app bar (with the module
/// info and filter buttons), debounced search, horizontal quick-filter chips,
/// card rows, pull-to-refresh and infinite scroll. Screens supply the data and
/// the row widget; the layout and the loading/empty/error states live here so
/// every module looks and behaves the same.
class ModuleListScaffold<T> extends StatefulWidget {
  const ModuleListScaffold({
    super.key,
    required this.title,
    required this.infoKey,
    required this.items,
    required this.itemBuilder,
    required this.onRefresh,
    required this.onLoadMore,
    required this.onSearch,
    this.quickFilters = const [],
    this.currentQuickFilter,
    this.onQuickFilter,
    this.onFilter,
    this.hasActiveFilter = false,
    this.searchHint = 'Search…',
    this.emptyMessage = 'Nothing here yet.',
    this.emptyIcon = Icons.inbox_outlined,
    this.loading = false,
    this.loadingMore = false,
    this.hasMore = false,
    this.error,
    this.fab,
  });

  final String title;

  /// Key into `kModuleInfo` for the ⓘ "how this works" dialog.
  final String infoKey;

  final List<T> items;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;
  final ValueChanged<String> onSearch;

  final List<QuickFilter> quickFilters;
  final String? currentQuickFilter;
  final ValueChanged<String>? onQuickFilter;

  /// Opens the module's advanced-filter sheet; null hides the filter button.
  final VoidCallback? onFilter;
  final bool hasActiveFilter;

  final String searchHint;
  final String emptyMessage;
  final IconData emptyIcon;

  final bool loading;
  final bool loadingMore;
  final bool hasMore;
  final String? error;

  final Widget? fab;

  @override
  State<ModuleListScaffold<T>> createState() => _ModuleListScaffoldState<T>();
}

class _ModuleListScaffoldState<T> extends State<ModuleListScaffold<T>> {
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
    if (_scrollCtl.position.pixels >= _scrollCtl.position.maxScrollExtent - 240) {
      widget.onLoadMore();
    }
  }

  void _onSearchChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () => widget.onSearch(q));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          ModuleInfoButton(widget.infoKey),
          if (widget.onFilter != null)
            IconButton(
              icon: Icon(widget.hasActiveFilter ? Icons.filter_alt : Icons.tune),
              color: widget.hasActiveFilter ? AppColors.primary : null,
              tooltip: 'Filter',
              onPressed: widget.onFilter,
            ),
        ],
      ),
      floatingActionButton: widget.fab,
      body: Column(
        children: [
          if (widget.quickFilters.isNotEmpty) _chips(),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.md12,
            ),
            child: AppTextField(
              controller: _searchCtl,
              hint: widget.searchHint,
              prefixIcon: Icons.search,
              onChanged: _onSearchChanged,
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _chips() {
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, AppSpacing.sm8, AppSpacing.md12, 0,
        ),
        children: [
          for (final f in widget.quickFilters)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.sm8),
              child: ChoiceChip(
                label: Text(f.label),
                selected: widget.currentQuickFilter == f.value,
                onSelected: (_) => widget.onQuickFilter?.call(f.value),
                selectedColor: AppColors.primaryTint,
                labelStyle: TextStyle(
                  color: widget.currentQuickFilter == f.value
                      ? AppColors.primary
                      : AppColors.text2,
                  fontWeight: widget.currentQuickFilter == f.value
                      ? FontWeight.w600
                      : FontWeight.w400,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _body() {
    if (widget.error != null) {
      return ErrorState(widget.error!, onRetry: widget.onRefresh);
    }
    if (widget.loading) {
      return LoadingState(message: 'Loading ${widget.title.toLowerCase()}…');
    }
    if (widget.items.isEmpty) {
      return EmptyState(widget.emptyMessage, icon: widget.emptyIcon);
    }
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView.separated(
        controller: _scrollCtl,
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md12, 0, AppSpacing.md12, AppSpacing.xxl32,
        ),
        itemCount: widget.items.length + (widget.hasMore ? 1 : 0),
        separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm8),
        itemBuilder: (context, i) {
          if (i >= widget.items.length) {
            return Padding(
              padding: const EdgeInsets.all(AppSpacing.lg16),
              child: Center(
                child: widget.loadingMore
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2.4),
                      )
                    : const SizedBox.shrink(),
              ),
            );
          }
          return widget.itemBuilder(context, widget.items[i]);
        },
      ),
    );
  }
}
