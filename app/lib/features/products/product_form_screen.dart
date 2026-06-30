import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/product_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/form_dropdowns.dart';
import '../../shared/widgets/form_section.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Product (Tally stock item) — mirrors the web `products/form.ejs`
/// field-for-field + its validation (Name required, SKU upper-cased). Sections
/// map to the web's tabs: Basic, Pricing & Tax, Stock & Inventory, Custom
/// Fields. Category is an FK dropdown; Unit + GST Rate are STRING dropdowns from
/// `GET /config/options`. GST rate arrives as a label ("18%") and is parsed to
/// the number the API expects. Submits POST (add) / PUT (edit).
class ProductFormScreen extends ConsumerStatefulWidget {
  const ProductFormScreen({super.key, this.productId});

  final int? productId; // null → Add; id → Edit
  bool get isEdit => productId != null;

  @override
  ConsumerState<ProductFormScreen> createState() => _ProductFormScreenState();
}

class _ProductFormScreenState extends ConsumerState<ProductFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _sku = TextEditingController();
  final _hsn = TextEditingController();
  final _description = TextEditingController();
  final _purchase = TextEditingController();
  final _sales = TextEditingController();
  final _opening = TextEditingController();

  String _status = 'Active';
  int? _categoryId;
  String? _unit;
  String? _gstRateLabel; // e.g. "18%" — parsed to a number on submit
  bool _isTallyItem = true; // web: checked by default on Add
  final List<CfRow> _customFields = [];

  bool _busy = false; // saving
  bool _loading = false; // fetching the row for Edit
  String? _loadError;

  @override
  void initState() {
    super.initState();
    if (widget.isEdit) _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _sku, _hsn, _description, _purchase, _sales, _opening]) {
      c.dispose();
    }
    for (final r in _customFields) {
      r.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _loadError = null; });
    try {
      final p = await ref.read(productRepositoryProvider).get(widget.productId!);
      _name.text = p.name;
      _sku.text = p.sku ?? '';
      _hsn.text = p.hsnCode ?? '';
      _description.text = p.description ?? '';
      _purchase.text = p.purchasePrice?.toString() ?? '';
      _sales.text = p.salesPrice?.toString() ?? '';
      _opening.text = p.openingStock?.toString() ?? '';
      _status = p.status ?? 'Active';
      _categoryId = p.categoryId;
      _unit = p.unit;
      _gstRateLabel = p.gstRateLabel;
      _isTallyItem = p.isTallyItem ?? false;
      _customFields
        ..clear()
        ..addAll(cfRowsFromMap(p.customFields));
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load product: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  num? _num(String s) => s.trim().isEmpty ? null : num.tryParse(s.trim());

  /// "18%" → 18, "12.5%" → 12.5, null/blank → null.
  num? _gstRate() {
    final l = _gstRateLabel;
    if (l == null || l.trim().isEmpty) return null;
    return num.tryParse(l.replaceAll('%', '').trim());
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      if (_sku.text.trim().isNotEmpty) 'sku': _sku.text.trim().toUpperCase(),
      if (_unit != null) 'unit': _unit,
      if (_hsn.text.trim().isNotEmpty) 'hsn_code': _hsn.text.trim(),
      if (_gstRate() != null) 'gst_rate': _gstRate(),
      if (_num(_purchase.text) != null) 'purchase_price': _num(_purchase.text),
      if (_num(_sales.text) != null) 'sales_price': _num(_sales.text),
      if (_num(_opening.text) != null) 'opening_stock': _num(_opening.text),
      if (_description.text.trim().isNotEmpty) 'description': _description.text.trim(),
      if (_categoryId != null) 'category_id': _categoryId,
      'status': _status,
      'is_tally_item': _isTallyItem,
      'custom_fields': cfRowsToMap(_customFields),
    };
    try {
      final repo = ref.read(productRepositoryProvider);
      if (widget.isEdit) {
        await repo.update(widget.productId!, body);
      } else {
        await repo.create(body);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
            content: Text(widget.isEdit ? 'Product updated.' : 'Product created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save product: $e');
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
      appBar: AppBar(title: Text(widget.isEdit ? 'Edit Product' : 'Add Product')),
      body: _loading
          ? const LoadingState(message: 'Loading product…')
          : _loadError != null
              ? ErrorState(_loadError!, onRetry: _load)
              : _buildForm(context),
    );
  }

  Widget _buildForm(BuildContext context) {
    const gap = SizedBox(height: AppSpacing.md12);
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          // ════ Basic Information ════
          const FormSectionTitle('Basic Information', first: true),
          AppTextField(
            controller: _name, label: 'Product Name *',
            prefixIcon: Icons.inventory_2_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          gap,
          AppTextField(controller: _sku, label: 'SKU / Item Code'),
          gap,
          FkDropdown(
            label: 'Category', endpoint: '/categories',
            value: _categoryId, onChanged: (v) => setState(() => _categoryId = v),
          ),
          gap,
          ConfigDropdown(
            label: 'Unit', configKey: 'units',
            value: _unit, onChanged: (v) => setState(() => _unit = v),
          ),
          gap,
          Text('Status *', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          DropdownButtonFormField<String>(
            value: _status,
            items: const ['Active', 'Inactive', 'Blocked']
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: (v) => setState(() => _status = v ?? 'Active'),
          ),
          const SizedBox(height: AppSpacing.sm8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Create as Tally stock item'),
            subtitle: const Text('Syncs this product to Tally as a stock item.'),
            value: _isTallyItem,
            onChanged: (v) => setState(() => _isTallyItem = v),
          ),
          gap,
          AppTextField(controller: _description, label: 'Product Description', maxLines: 3),

          // ════ Pricing & Tax ════
          const FormSectionTitle('Pricing & Tax'),
          AppTextField(controller: _hsn, label: 'HSN / SAC Code'),
          gap,
          ConfigDropdown(
            label: 'GST Rate', configKey: 'gst_rates',
            value: _gstRateLabel, onChanged: (v) => setState(() => _gstRateLabel = v),
          ),
          gap,
          Row(
            children: [
              Expanded(child: AppTextField(
                controller: _purchase, label: 'Purchase Price (₹)',
                keyboardType: TextInputType.number,
              )),
              const SizedBox(width: AppSpacing.md12),
              Expanded(child: AppTextField(
                controller: _sales, label: 'Sales Price (₹)',
                keyboardType: TextInputType.number,
              )),
            ],
          ),

          // ════ Stock & Inventory ════
          const FormSectionTitle('Stock & Inventory'),
          AppTextField(
            controller: _opening, label: 'Opening Stock',
            keyboardType: TextInputType.number,
          ),

          // ════ Custom Fields ════
          const FormSectionTitle('Custom Fields'),
          CustomFieldsEditor(
            rows: _customFields,
            onAdd: () => setState(() => _customFields.add(CfRow('', ''))),
            onRemove: (i) => setState(() => _customFields.removeAt(i).dispose()),
          ),

          const SizedBox(height: AppSpacing.xl24),
          AppButton(
            label: widget.isEdit ? 'Update Product' : 'Save Product',
            loading: _busy, onPressed: _save,
          ),
        ],
      ),
    );
  }
}
