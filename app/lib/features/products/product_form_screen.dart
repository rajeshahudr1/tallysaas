import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/product_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/form_dropdowns.dart';

/// Add Product (Tally stock item) form. Category is an FK dropdown
/// (`/categories`, id+name); Unit + GST Rate are STRING dropdowns from
/// `GET /config/options` (single source, shared with web). The GST rate arrives
/// as a label like "18%" and is parsed to the number the API expects. Submits
/// `POST /products`, then pops `true` so the list refreshes.
class ProductFormScreen extends ConsumerStatefulWidget {
  const ProductFormScreen({super.key});

  @override
  ConsumerState<ProductFormScreen> createState() => _ProductFormScreenState();
}

class _ProductFormScreenState extends ConsumerState<ProductFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _sku = TextEditingController();
  final _hsn = TextEditingController();
  final _purchase = TextEditingController();
  final _sales = TextEditingController();
  final _opening = TextEditingController();

  String _status = 'Active';
  int? _categoryId;
  String? _unit;
  String? _gstRateLabel; // e.g. "18%" — parsed to a number on submit
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _sku, _hsn, _purchase, _sales, _opening]) {
      c.dispose();
    }
    super.dispose();
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
    try {
      await ref.read(productRepositoryProvider).create({
        'name': _name.text.trim(),
        if (_sku.text.trim().isNotEmpty) 'sku': _sku.text.trim(),
        if (_unit != null) 'unit': _unit,
        if (_hsn.text.trim().isNotEmpty) 'hsn_code': _hsn.text.trim(),
        if (_gstRate() != null) 'gst_rate': _gstRate(),
        if (_num(_purchase.text) != null) 'purchase_price': _num(_purchase.text),
        if (_num(_sales.text) != null) 'sales_price': _num(_sales.text),
        if (_num(_opening.text) != null) 'opening_stock': _num(_opening.text),
        if (_categoryId != null) 'category_id': _categoryId,
        'status': _status,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Product created.')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not create product: $e');
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
      appBar: AppBar(title: const Text('Add Product')),
      body: Form(
        key: _formKey,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg16),
          children: [
            AppTextField(
              controller: _name, label: 'Product Name',
              prefixIcon: Icons.inventory_2_outlined,
              validator: (v) => Validators.required(v, 'Name'),
            ),
            const SizedBox(height: AppSpacing.md12),
            Row(
              children: [
                Expanded(child: AppTextField(controller: _sku, label: 'SKU')),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(controller: _hsn, label: 'HSN Code')),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),

            // FK dropdown — categories master (id+name).
            FkDropdown(
              label: 'Category', endpoint: '/categories',
              value: _categoryId, onChanged: (v) => setState(() => _categoryId = v),
            ),
            const SizedBox(height: AppSpacing.md12),

            // String dropdowns — choices from GET /config/options (single source).
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: ConfigDropdown(
                  label: 'Unit', configKey: 'units',
                  value: _unit, onChanged: (v) => setState(() => _unit = v),
                )),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: ConfigDropdown(
                  label: 'GST Rate', configKey: 'gst_rates',
                  value: _gstRateLabel, onChanged: (v) => setState(() => _gstRateLabel = v),
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),

            Row(
              children: [
                Expanded(child: AppTextField(
                  controller: _purchase, label: 'Purchase Price',
                  keyboardType: TextInputType.number,
                )),
                const SizedBox(width: AppSpacing.md12),
                Expanded(child: AppTextField(
                  controller: _sales, label: 'Sales Price',
                  keyboardType: TextInputType.number,
                )),
              ],
            ),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(
              controller: _opening, label: 'Opening Stock',
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: AppSpacing.md12),

            // Products use a 2-state lifecycle (Active/Inactive) — the same set
            // the API validates.
            Text('Status', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.sm8),
            DropdownButtonFormField<String>(
              value: _status,
              items: const ['Active', 'Inactive']
                  .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                  .toList(),
              onChanged: (v) => setState(() => _status = v ?? 'Active'),
            ),
            const SizedBox(height: AppSpacing.xl24),

            AppButton(label: 'Save Product', loading: _busy, onPressed: _save),
          ],
        ),
      ),
    );
  }
}
