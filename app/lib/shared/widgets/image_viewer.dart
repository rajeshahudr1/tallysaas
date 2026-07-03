import 'package:flutter/material.dart';

/// Fullscreen, swipeable, pinch-to-zoom image viewer for a product's gallery.
/// Opened by tapping a product thumbnail (list) or a gallery image (detail).
/// [images] are absolute URLs (the API builds them).
Future<void> showImageGallery(
  BuildContext context,
  List<String> images, {
  int initialIndex = 0,
  String? title,
}) {
  final imgs = images.where((u) => u.trim().isNotEmpty).toList();
  if (imgs.isEmpty) return Future<void>.value();
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black,
    builder: (_) => _ImageGalleryDialog(
      images: imgs,
      initialIndex: initialIndex.clamp(0, imgs.length - 1),
      title: title,
    ),
  );
}

class _ImageGalleryDialog extends StatefulWidget {
  const _ImageGalleryDialog(
      {required this.images, this.initialIndex = 0, this.title});
  final List<String> images;
  final int initialIndex;
  final String? title;

  @override
  State<_ImageGalleryDialog> createState() => _ImageGalleryDialogState();
}

class _ImageGalleryDialogState extends State<_ImageGalleryDialog> {
  late final PageController _pc =
      PageController(initialPage: widget.initialIndex);
  late int _index = widget.initialIndex;

  @override
  void dispose() {
    _pc.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final many = widget.images.length > 1;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        elevation: 0,
        title: Text(
          many
              ? '${_index + 1} / ${widget.images.length}'
              : (widget.title ?? 'Image'),
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      body: PageView.builder(
        controller: _pc,
        itemCount: widget.images.length,
        onPageChanged: (i) => setState(() => _index = i),
        itemBuilder: (_, i) => InteractiveViewer(
          minScale: 1,
          maxScale: 4,
          child: Center(
            child: Image.network(
              widget.images[i],
              fit: BoxFit.contain,
              loadingBuilder: (c, child, progress) => progress == null
                  ? child
                  : const Center(
                      child: CircularProgressIndicator(color: Colors.white70)),
              errorBuilder: (c, e, s) => const Center(
                  child: Icon(Icons.broken_image_outlined,
                      color: Colors.white38, size: 48)),
            ),
          ),
        ),
      ),
    );
  }
}
