import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../app/theme.dart';
import '../../core/api/api_exception.dart';
import '../../data/models/product.dart';
import '../../data/repositories/product_repository.dart';
import '../../shared/widgets/image_viewer.dart';

/// Product image gallery for the detail screen — shows the stored photos and,
/// when the user has `products.edit`, lets them add (gallery / camera) or remove
/// images. Images live only in our cloud (local storage on the API); they are
/// NOT synced to Tally, which has no stock-item image field.
///
/// Self-contained: it (re)loads its own list from `GET /products/:id/images`
/// after every upload/delete, so it stays authoritative regardless of the
/// detail record's cached `initial` list.
class ProductImagesSection extends ConsumerStatefulWidget {
  const ProductImagesSection({
    super.key,
    required this.productId,
    this.initial = const [],
    this.canEdit = false,
  });

  final int productId;
  final List<ProductImage> initial;
  final bool canEdit;

  @override
  ConsumerState<ProductImagesSection> createState() =>
      _ProductImagesSectionState();
}

class _ProductImagesSectionState extends ConsumerState<ProductImagesSection> {
  late List<ProductImage> _images = List.of(widget.initial);
  final ImagePicker _picker = ImagePicker();
  bool _loading = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    if (mounted) setState(() => _loading = true);
    try {
      final imgs =
          await ref.read(productRepositoryProvider).images(widget.productId);
      if (mounted) setState(() => _images = imgs);
    } catch (_) {
      // keep whatever we had; a transient list error shouldn't blank the gallery
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade700 : null,
    ));
  }

  void _openAddSheet() {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose from gallery'),
              subtitle: const Text('Select up to 8 photos'),
              onTap: () {
                Navigator.pop(ctx);
                _addFromGallery();
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () {
                Navigator.pop(ctx);
                _addFromCamera();
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _addFromGallery() async {
    try {
      final picked =
          await _picker.pickMultiImage(imageQuality: 82, maxWidth: 1600);
      if (picked.isEmpty) return;
      await _upload(picked);
    } catch (_) {
      _toast('Could not open the gallery.', error: true);
    }
  }

  Future<void> _addFromCamera() async {
    try {
      final shot = await _picker.pickImage(
          source: ImageSource.camera, imageQuality: 82, maxWidth: 1600);
      if (shot == null) return;
      await _upload([shot]);
    } catch (_) {
      _toast('Could not open the camera.', error: true);
    }
  }

  Future<void> _upload(List<XFile> files) async {
    var list = files;
    if (list.length > 8) {
      list = list.sublist(0, 8);
      _toast('Only the first 8 images were uploaded.');
    }
    setState(() => _busy = true);
    try {
      final payload = <PickedImage>[];
      for (final x in list) {
        payload.add(PickedImage(await x.readAsBytes(), x.name));
      }
      await ref
          .read(productRepositoryProvider)
          .uploadImages(widget.productId, payload);
      await _reload();
      _toast(
          '${payload.length} image${payload.length == 1 ? '' : 's'} uploaded.');
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } catch (_) {
      _toast('Upload failed. Please try again.', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmDelete(ProductImage img) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove image?'),
        content: const Text('This photo will be removed from the product.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      await ref
          .read(productRepositoryProvider)
          .deleteImage(widget.productId, img.id);
      await _reload();
      _toast('Image removed.');
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } catch (_) {
      _toast('Could not remove the image.', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '${_images.length} image${_images.length == 1 ? '' : 's'} · stored in your cloud (not synced to Tally)',
                style: theme.textTheme.bodySmall,
              ),
            ),
            if (widget.canEdit)
              TextButton.icon(
                onPressed: _busy ? null : _openAddSheet,
                icon: const Icon(Icons.add_a_photo_outlined, size: 18),
                label: const Text('Add'),
              ),
          ],
        ),
        SizedBox(
          height: 3,
          child: _busy ? const LinearProgressIndicator(minHeight: 2) : null,
        ),
        const SizedBox(height: AppSpacing.sm8),
        if (_images.isEmpty && !_loading)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl24),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: theme.dividerColor),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              children: [
                Icon(Icons.image_outlined,
                    color: theme.disabledColor, size: 32),
                const SizedBox(height: 6),
                Text(
                  widget.canEdit
                      ? 'No images yet — tap Add to upload.'
                      : 'No images.',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          )
        else
          Wrap(
            spacing: AppSpacing.sm8,
            runSpacing: AppSpacing.sm8,
            children: [for (final img in _images) _thumb(img)],
          ),
      ],
    );
  }

  Widget _thumb(ProductImage img) {
    return GestureDetector(
      onTap: () => showImageGallery(
        context,
        _images.map((i) => i.url).toList(),
        initialIndex: _images.indexOf(img),
        title: 'Product Images',
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Stack(
          children: [
            Image.network(
              img.url,
              width: 96,
              height: 96,
              fit: BoxFit.cover,
              loadingBuilder: (c, child, progress) => progress == null
                  ? child
                  : Container(
                      width: 96,
                      height: 96,
                      color: Colors.black12,
                      child: const Center(
                        child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2)),
                      ),
                    ),
              errorBuilder: (c, e, s) => Container(
                width: 96,
                height: 96,
                color: Colors.black12,
                child: const Icon(Icons.broken_image_outlined),
              ),
            ),
            if (widget.canEdit)
              Positioned(
                top: 2,
                right: 2,
                child: InkWell(
                  onTap: _busy ? null : () => _confirmDelete(img),
                  child: Container(
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      color: Colors.black54,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child:
                        const Icon(Icons.close, size: 16, color: Colors.white),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
