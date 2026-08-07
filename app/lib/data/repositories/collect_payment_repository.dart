import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/payment_request.dart';

/// Collect Payments endpoints — UPI-first payment requests, no gateway.
///
///   • GET  /collect-payments?page&per_page&status
///   • POST /collect-payments                      { invoice_id, note? }
///   • POST /collect-payments/:id/mark-paid        (also writes the receipt)
///   • POST /collect-payments/:id/cancel
///   • GET  /collect-payments/outstanding-invoices (the pick-list)
///   • GET  /collect-payments/settings
///   • PUT  /collect-payments/settings             { enabled, upi_vpa, payee_name }
///
/// The request AMOUNT is never sent by the client — the API reads it from the
/// invoice. `paid` is only ever reached through mark-paid, which atomically
/// records the receipt too.
class CollectPaymentRepository {
  CollectPaymentRepository(this._api);
  final ApiClient _api;

  static const _base = '/collect-payments';

  Future<PagedResult<PaymentRequest>> list({
    int page = 1,
    int perPage = 10,
    String? status,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (status != null && status.isNotEmpty) query['status'] = status;
    final data = await _api.get(_base, query: query);
    return PagedResult<PaymentRequest>.fromData(data, PaymentRequest.fromJson);
  }

  Future<PaymentRequest> create(int invoiceId, {String? note}) async {
    final data = await _api.post(_base, body: {
      'invoice_id': invoiceId,
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
    return PaymentRequest.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<void> markPaid(int id) => _api.post('$_base/$id/mark-paid');

  Future<void> cancel(int id) => _api.post('$_base/$id/cancel');

  Future<List<OutstandingInvoice>> outstandingInvoices() async {
    final data = await _api.get('$_base/outstanding-invoices');
    final rows = (data is Map && data['data'] is List)
        ? data['data'] as List
        : (data is List ? data : const []);
    return rows
        .whereType<Map>()
        .map((m) => OutstandingInvoice.fromJson(m.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<CollectPaymentSettings> settings() async {
    final data = await _api.get('$_base/settings');
    final map = (data is Map) ? data.cast<String, dynamic>() : const <String, dynamic>{};
    final s = (map['settings'] is Map)
        ? (map['settings'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    return CollectPaymentSettings.fromJson(s);
  }

  Future<void> saveSettings(CollectPaymentSettings s) =>
      _api.put('$_base/settings', body: s.toJson());
}

final collectPaymentRepositoryProvider = Provider<CollectPaymentRepository>((ref) {
  return CollectPaymentRepository(ref.watch(apiClientProvider));
});
