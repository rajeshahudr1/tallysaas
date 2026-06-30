import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/category_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Category (Tally stock group) — mirrors the web `categories/form.ejs`
/// (Name required, Parent self-FK optional → top-level, Status Active/Inactive).
/// Submits POST (add) / PUT (edit), then pops `true` so the list refreshes.
class CategoryFormScreen extends ConsumerStatefulWidget {
  const CategoryFormScreen({super.key, this.categoryId});

  final int? categoryId; // null → Add; id → Edit
  bool get isEdit => categoryId != null;

  @override
  ConsumerState<CategoryFormScreen> createState() => _CategoryFormScreenState();
}

class _CategoryFormScreenState extends ConsumerState<CategoryFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();

  String _status = 'Active';
  int? _parentId;

  bool _busy = false;
  bool _loading = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    if (widget.isEdit) _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _loadError = null; });
    try {
      final c = await ref.read(categoryRepositoryProvider).get(widget.categoryId!);
      _name.text = c.name;
      _parentId = c.parentId;
      _status = c.status ?? 'Active';
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load category: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      if (_parentId != null) 'parent_id': _parentId,
      'status': _status,
    };
    try {
      final repo = ref.read(categoryRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.categoryId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Category updated.' : 'Category created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save category: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Category' : 'Add Category')),
      body: _loading
          ? const LoadingState(message: 'Loading category…')
          : _loadError != null
              ? ErrorState(_loadError!, onRetry: _load)
              : _buildForm(context),
    );
  }

  Widget _buildForm(BuildContext context) {
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          AppTextField(
            controller: _name, label: 'Category Name *',
            prefixIcon: Icons.category_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          const SizedBox(height: AppSpacing.md12),
          // Self-FK — parent category (optional → top-level).
          FkDropdown(
            label: 'Parent Category', endpoint: '/categories',
            value: _parentId, onChanged: (v) => setState(() => _parentId = v),
          ),
          const SizedBox(height: AppSpacing.md12),
          Text('Status *', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          DropdownButtonFormField<String>(
            value: _status,
            items: const ['Active', 'Inactive']
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: (v) => setState(() => _status = v ?? 'Active'),
          ),
          const SizedBox(height: AppSpacing.xl24),
          AppButton(
            label: widget.isEdit ? 'Update Category' : 'Save Category',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}
