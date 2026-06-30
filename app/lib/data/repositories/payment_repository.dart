import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/payment.dart';

/// Voucher endpoints — one repository serves BOTH payment (money out) and
/// receipt (money in) vouchers via the [basePath] (`/payments` | `/receipts`);
/// they share one server table. Company rides the `X-Company-Id` header.
///
///   • GET    <base>?page&per_page&search&status&mode   → { data, meta }
///   • POST   <base>                                     (create)
///   • DELETE <base>/:id                                 (soft delete)
class PaymentRepository {
  PaymentRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Payment>> list(
    String basePath, {
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
    String? dateFrom,
    String? dateTo,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (dateFrom != null) query['date_from'] = dateFrom;
    if (dateTo != null) query['date_to'] = dateTo;
    final data = await _api.get(basePath, query: query);
    return PagedResult<Payment>.fromData(data, Payment.fromJson);
  }

  /// Fetch ONE voucher — drives the View (detail) screen.
  Future<Payment> get(String basePath, int id) async {
    final data = await _api.get('$basePath/$id');
    return Payment.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<dynamic> create(String basePath, Map<String, dynamic> body) =>
      _api.post(basePath, body: body);

  Future<void> delete(String basePath, int id) => _api.delete('$basePath/$id');
}

final paymentRepositoryProvider = Provider<PaymentRepository>((ref) {
  return PaymentRepository(ref.watch(apiClientProvider));
});
