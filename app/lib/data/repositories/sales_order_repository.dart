import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/sales_order.dart';

/// Sales-order endpoints. Company rides the `X-Company-Id` header.
///
///   • GET    /sales-orders?page&per_page&search&date_from&date_to&order_status&mine
///   • GET    /sales-orders/:id             → header + items
///   • POST   /sales-orders                 (create; auto order_no when blank)
///   • PUT    /sales-orders/:id             (edit a DRAFT)
///   • POST   /sales-orders/:id/convert     (turn the order into a sales invoice)
///   • DELETE /sales-orders/:id             (soft delete)
///
/// NOTE `order_status` is the DELIVERY filter (pending / partially_delivered /
/// delivered / cancelled / all) — not `status`, which is the Tally-sync
/// lifecycle everywhere in this product.
class SalesOrderRepository {
  SalesOrderRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<SalesOrder>> list({
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
    final data = await _api.get(Endpoints.salesOrders, query: query);
    return PagedResult<SalesOrder>.fromData(data, SalesOrder.fromJson);
  }

  Future<SalesOrder> get(int id) async {
    final data = await _api.get('${Endpoints.salesOrders}/$id');
    return SalesOrder.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.salesOrders, body: body);

  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.salesOrders}/$id', body: body);

  Future<dynamic> convert(int id) =>
      _api.post('${Endpoints.salesOrders}/$id/convert');

  Future<void> delete(int id) => _api.delete('${Endpoints.salesOrders}/$id');
}

final salesOrderRepositoryProvider = Provider<SalesOrderRepository>((ref) {
  return SalesOrderRepository(ref.watch(apiClientProvider));
});
