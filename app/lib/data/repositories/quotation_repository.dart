import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/paged.dart';
import '../models/quotation.dart';

/// Quotation endpoints. Company rides the `X-Company-Id` header.
///
///   • GET    /quotations?page&per_page&search&date_from&date_to&quote_status&mine
///   • GET    /quotations/:id            → header + items
///   • POST   /quotations                (create; auto quotation_no when blank)
///   • PUT    /quotations/:id            (edit a DRAFT)
///   • POST   /quotations/:id/convert    (turn an accepted quote into a sales invoice)
///   • DELETE /quotations/:id            (soft delete)
///
/// NOTE `quote_status` is the DEAL filter (open/accepted/rejected/expired/all).
/// It is deliberately not called `status` — that name is the Tally-sync
/// lifecycle everywhere in this product.
class QuotationRepository {
  QuotationRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Quotation>> list({
    int page = 1,
    int perPage = 10,
    String? search,
    String? quoteStatus,
    String? dateFrom,
    String? dateTo,
    bool mine = false,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (quoteStatus != null && quoteStatus.isNotEmpty) query['quote_status'] = quoteStatus;
    if (dateFrom != null && dateFrom.isNotEmpty) query['date_from'] = dateFrom;
    if (dateTo != null && dateTo.isNotEmpty) query['date_to'] = dateTo;
    if (mine) query['mine'] = '1';
    final data = await _api.get(Endpoints.quotations, query: query);
    return PagedResult<Quotation>.fromData(data, Quotation.fromJson);
  }

  Future<Quotation> get(int id) async {
    final data = await _api.get('${Endpoints.quotations}/$id');
    return Quotation.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.quotations, body: body);

  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.quotations}/$id', body: body);

  /// Converts the quotation into a sales invoice; returns the API payload,
  /// which carries the new invoice id.
  Future<dynamic> convert(int id) =>
      _api.post('${Endpoints.quotations}/$id/convert');

  Future<void> delete(int id) => _api.delete('${Endpoints.quotations}/$id');
}

final quotationRepositoryProvider = Provider<QuotationRepository>((ref) {
  return QuotationRepository(ref.watch(apiClientProvider));
});
