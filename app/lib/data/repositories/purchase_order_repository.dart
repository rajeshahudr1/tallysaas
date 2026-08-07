import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/purchase_order.dart';

/// Purchase-order endpoints. Company rides the `X-Company-Id` header.
///
///   • GET    /purchase-orders?page&per_page&search&date_from&date_to&order_status&mine
///   • GET    /purchase-orders/:id             → header + items
///   • POST   /purchase-orders                 (create; auto order_no when blank)
///   • PUT    /purchase-orders/:id             (edit a DRAFT)
///   • POST   /purchase-orders/:id/convert     (turn the order into a purchase invoice)
///   • DELETE /purchase-orders/:id             (soft delete)
///
/// NOTE `order_status` is the DELIVERY filter (pending / partially_delivered /
/// delivered / cancelled / all) — not `status`, which is the Tally-sync
/// lifecycle everywhere in this product.
class PurchaseOrderRepository {
  PurchaseOrderRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<PurchaseOrder>> list({
    int page = 1,
    int perPage = 10,
    String? search,
    String? orderStatus,
    String? dateFrom,
    String? dateTo,
    bool mine = false,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (orderStatus != null && orderStatus.isNotEmpty) query['order_status'] = orderStatus;
    if (dateFrom != null && dateFrom.isNotEmpty) query['date_from'] = dateFrom;
    if (dateTo != null && dateTo.isNotEmpty) query['date_to'] = dateTo;
    if (mine) query['mine'] = '1';
    final data = await _api.get(Endpoints.purchaseOrders, query: query);
    return PagedResult<PurchaseOrder>.fromData(data, PurchaseOrder.fromJson);
  }

  Future<PurchaseOrder> get(int id) async {
    final data = await _api.get('${Endpoints.purchaseOrders}/$id');
    return PurchaseOrder.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.purchaseOrders, body: body);

  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.purchaseOrders}/$id', body: body);

  Future<dynamic> convert(int id) =>
      _api.post('${Endpoints.purchaseOrders}/$id/convert');

  Future<void> delete(int id) => _api.delete('${Endpoints.purchaseOrders}/$id');
}

final purchaseOrderRepositoryProvider = Provider<PurchaseOrderRepository>((ref) {
  return PurchaseOrderRepository(ref.watch(apiClientProvider));
});
