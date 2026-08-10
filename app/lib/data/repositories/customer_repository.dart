import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/customer.dart';
import '../models/paged.dart';

/// Customer master endpoints. The active company rides the `X-Company-Id`
/// header (set by the ApiClient interceptor), so these methods never pass a
/// company id — the server scopes by it. Mirrors the web BFF's customer routes.
///
///   • GET    /customers?page&per_page&search&status   → { data, meta }   [customers.view]
///   • GET    /customers/:id                            → { data }         [customers.view]
///   • POST   /customers                               (create)          [customers.create]
///   • PUT    /customers/:id                           (update)          [customers.edit]
///   • DELETE /customers/:id                           (soft delete)     [customers.delete]
class CustomerRepository {
  CustomerRepository(this._api);
  final ApiClient _api;

  Future<PagedResult<Customer>> list({
    int page = 1,
    int perPage = 20,
    String? search,
    String? status,
    String? location,        // filters by locations.name (server FILTER_MAP)
    String? salesPerson,     // sales_persons.name
    String? customerGroup,   // customer_groups.name
    String? gst,             // customers.gst_number ILIKE
    String? createdFrom,     // YYYY-MM-DD
    String? createdTo,
    /// The Parties screen tabs.  is the starred shortlist;
    ///  is its mirror of the Inactive tile — parties WITH a sale
    /// in the last N days.
    bool favourite = false,
    int? activeDays,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (location != null && location.isNotEmpty) query['location'] = location;
    if (salesPerson != null && salesPerson.isNotEmpty) query['sales_person'] = salesPerson;
    if (customerGroup != null && customerGroup.isNotEmpty) query['customer_group'] = customerGroup;
    if (gst != null && gst.trim().isNotEmpty) query['gst'] = gst.trim();
    if (createdFrom != null) query['created_from'] = createdFrom;
    if (createdTo != null) query['created_to'] = createdTo;
    if (favourite) query['favourite'] = 1;
    if (activeDays != null) query['active'] = activeDays;
    final data = await _api.get(Endpoints.customers, query: query);
    return PagedResult<Customer>.fromData(data, Customer.fromJson);
  }

  /// Fetch ONE customer with every editable column — drives the View + Edit
  /// screens (the list projection alone can't pre-fill the form).
  Future<Customer> get(int id) async {
    final data = await _api.get('${Endpoints.customers}/$id');
    if (data is! Map) {
      throw StateError('Customer response was not a JSON object.');
    }
    return Customer.fromJson(data.cast<String, dynamic>());
  }

  /// Create a customer. `body` carries the known columns (name required; the
  /// rest optional FKs/fields). Returns the created row's `data`.
  Future<dynamic> create(Map<String, dynamic> body) =>
      _api.post(Endpoints.customers, body: body);

  /// Update a customer (`PUT /customers/:id`). Same `body` shape as [create].
  Future<dynamic> update(int id, Map<String, dynamic> body) =>
      _api.put('${Endpoints.customers}/$id', body: body);

  /// Star / unstar a party. A one-field PUT through the normal update
  /// route, so the same permission check applies as to any other edit —
  /// and because it is cloud-only metadata, the server does NOT mark the
  /// ledger dirty for Tally.
  Future<dynamic> setFavourite(int id, bool on) =>
      _api.put('${Endpoints.customers}/$id', body: {'is_favourite': on});
  Future<void> delete(int id) => _api.delete('${Endpoints.customers}/$id');
}

final customerRepositoryProvider = Provider<CustomerRepository>((ref) {
  return CustomerRepository(ref.watch(apiClientProvider));
});
