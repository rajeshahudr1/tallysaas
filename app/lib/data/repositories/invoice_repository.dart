import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/invoice.dart';
import '../models/paged.dart';

/// Invoice endpoints — one repository serves BOTH voucher kinds via the
/// [basePath] (`/sales-invoices` or `/purchase-invoices`); the controller is
/// shared server-side. Company rides the `X-Company-Id` header.
///
///   • GET    <base>?page&per_page&search&status   → { data, meta }
///   • GET    <base>/:id                            → invoice + nested items
///   • POST   <base>                                (create; totals server-side)
///   • DELETE <base>/:id                            (soft delete)
class InvoiceRepository {
  InvoiceRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Invoice>> list(
    String basePath, {
    int page = 1,
    int perPage = 10,
    String? search,
    Map<String, String>? filters,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (filters != null) query.addAll(filters);
    final data = await _api.get(basePath, query: query);
    return PagedResult<Invoice>.fromData(data, Invoice.fromJson);
  }

  Future<Invoice> get(String basePath, int id) async {
    final data = await _api.get('$basePath/$id');
    return Invoice.fromJson((data as Map).cast<String, dynamic>());
  }

  /// Create. `body` carries the header fields + an `items` array; the server
  /// computes every money total. Returns the created invoice (with items).
  Future<Invoice> create(String basePath, Map<String, dynamic> body) async {
    final data = await _api.post(basePath, body: body);
    return Invoice.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<void> delete(String basePath, int id) => _api.delete('$basePath/$id');

  // ── SFA · field-sales approval workflow (sales invoices only) ──────────
  /// Admin approves a pending field invoice → it counts + becomes Tally-eligible.
  Future<void> approve(int id) =>
      _api.post('${Endpoints.salesInvoices}/$id/approve', body: const {});

  /// Admin rejects a pending field invoice with a reason (shown to the salesman).
  Future<void> reject(int id, String reason) =>
      _api.post('${Endpoints.salesInvoices}/$id/reject', body: {'reason': reason});

  /// Salesman submits their own DRAFT for approval ('draft' → 'pending').
  Future<void> submitDraft(int id) =>
      _api.post('${Endpoints.salesInvoices}/$id/submit', body: const {});

  /// Edit an un-approved invoice (draft/pending/rejected). Passing
  /// save_as_draft:false re-submits it for approval in the same call
  /// (rejected/draft → pending). Returns the updated invoice.
  Future<Invoice> updateSales(int id, Map<String, dynamic> body) async {
    final data = await _api.put('${Endpoints.salesInvoices}/$id', body: body);
    return Invoice.fromJson((data as Map).cast<String, dynamic>());
  }

  /// Fetch a single sales invoice (header + line items) — for the edit form.
  Future<Invoice> getSales(int id) => get(Endpoints.salesInvoices, id);

  // Convenience aliases for the two endpoints.
  Future<PagedResult<Invoice>> listSales({int page = 1, int perPage = 10, String? search, Map<String, String>? filters}) =>
      list(Endpoints.salesInvoices, page: page, perPage: perPage, search: search, filters: filters);
  Future<Invoice> createSales(Map<String, dynamic> body) => create(Endpoints.salesInvoices, body);

  Future<PagedResult<Invoice>> listPurchase({int page = 1, int perPage = 10, String? search, Map<String, String>? filters}) =>
      list(Endpoints.purchaseInvoices, page: page, perPage: perPage, search: search, filters: filters);
  Future<Invoice> createPurchase(Map<String, dynamic> body) => create(Endpoints.purchaseInvoices, body);
}

final invoiceRepositoryProvider = Provider<InvoiceRepository>((ref) {
  return InvoiceRepository(ref.watch(apiClientProvider));
});
