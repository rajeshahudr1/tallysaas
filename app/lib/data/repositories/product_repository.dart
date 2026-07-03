import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http_parser/http_parser.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/product.dart';

/// Product master endpoints (Tally stock items). The active company rides the
/// `X-Company-Id` header (ApiClient interceptor). Mirrors the web BFF's product
/// routes.
///
///   • GET    /products?page&per_page&search&status   → { data, meta }   [products.view]
///   • GET    /products/:id                            → { data }         [products.view]
///   • POST   /products                               (create)          [products.create]
///   • PUT    /products/:id                           (update)          [products.edit]
///   • DELETE /products/:id                           (soft delete)     [products.delete]
///
/// Image gallery (local storage; NOT synced to Tally — absolute urls):
///   • GET    /products/:id/images                     → [{ id, url }]    [products.view]
///   • POST   /products/:id/images        (multipart `images`)           [products.edit]
///   • DELETE /products/:id/images/:imageId                              [products.edit]
class ProductRepository {
  ProductRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Product>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(Endpoints.products, query: query);
    return PagedResult<Product>.fromData(data, Product.fromJson);
  }

  /// Fetch ONE product with every editable column — drives View + Edit.
  Future<Product> get(int id) async {
    final data = await _api.get('${Endpoints.products}/$id');
    if (data is! Map) {
      throw StateError('Product response was not a JSON object.');
    }
    return Product.fromJson(data.cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.products, body: body);

  /// Update a product (`PUT /products/:id`). Same `body` shape as [create].
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.products}/$id', body: body);

  Future<void> delete(int id) => _api.delete('${Endpoints.products}/$id');

  // ── Image gallery ──────────────────────────────────────────────

  /// The product's full gallery (absolute urls, sorted).
  Future<List<ProductImage>> images(int id) async {
    final data = await _api.get(Endpoints.productImages(id));
    return _parseImages(data);
  }

  /// Upload one or more picked images as multipart (`images` field, repeated).
  /// A matching image content-type is set per file so the API's mime filter
  /// accepts them (Dio would otherwise send `application/octet-stream`).
  /// Returns the newly-created rows.
  Future<List<ProductImage>> uploadImages(int id, List<PickedImage> files) async {
    final form = FormData();
    for (final f in files) {
      form.files.add(MapEntry(
        'images',
        MultipartFile.fromBytes(f.bytes, filename: f.name, contentType: _mediaType(f.name)),
      ));
    }
    final data = await _api.uploadMultipart(Endpoints.productImages(id), form: form);
    return _parseImages(data);
  }

  /// Remove one image (soft-delete + file unlink server-side).
  Future<void> deleteImage(int id, int imageId) =>
      _api.delete(Endpoints.productImage(id, imageId));

  /// Both the list + upload endpoints wrap the array as `{ data: [...] }`.
  static List<ProductImage> _parseImages(dynamic data) {
    final list = (data is Map && data['data'] is List)
        ? data['data'] as List
        : (data is List ? data : const <dynamic>[]);
    return list
        .whereType<Map>()
        .map((m) => ProductImage.fromJson(m.cast<String, dynamic>()))
        .toList();
  }

  static MediaType _mediaType(String filename) {
    final f = filename.toLowerCase();
    if (f.endsWith('.png')) return MediaType('image', 'png');
    if (f.endsWith('.webp')) return MediaType('image', 'webp');
    if (f.endsWith('.gif')) return MediaType('image', 'gif');
    return MediaType('image', 'jpeg');
  }
}

/// A picked image ready to upload — bytes + a filename (extension drives the
/// content-type). Framework-agnostic so the data layer stays free of
/// image_picker types.
class PickedImage {
  const PickedImage(this.bytes, this.name);
  final Uint8List bytes;
  final String name;
}

final productRepositoryProvider = Provider<ProductRepository>((ref) {
  return ProductRepository(ref.watch(apiClientProvider));
});
