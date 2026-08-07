import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../models/paged.dart';
import '../models/portal_user.dart';

/// Portals — customer-portal logins and third-party API users.
///
/// Customer Users ride on the CUSTOMERS resource (a customer with a `user_id`
/// has a login), so the list is `/customers` and the writes are nested under
/// that customer:
///   • GET /customers?page&per_page&search
///   • GET /customers/:id/assignments      → login + catalog
///   • POST /customers/:id/login           { email, password?, role_id, status? }
///   • PUT  /customers/:id/catalog         { categories: [...] }
///
/// Website Users are their own resource:
///   • GET  /website-users?page&per_page&search
///   • GET  /website-users/:id
///   • POST /website-users                 { name, email, password, role_id, … }
///   • PUT  /website-users/:id             (any subset)
///   • POST /website-users/:id/regenerate-token
class PortalRepository {
  PortalRepository(this._api);
  final ApiClient _api;

  // ── Customer users ───────────────────────────────────────────
  Future<PagedResult<CustomerUser>> customerUsers({
    int page = 1,
    int perPage = 20,
    String? search,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    final data = await _api.get('/customers', query: query);
    return PagedResult<CustomerUser>.fromData(data, CustomerUser.fromJson);
  }

  /// The customer's login state + catalog assignment.
  Future<Map<String, dynamic>> assignments(int customerId) async {
    final data = await _api.get('/customers/$customerId/assignments');
    return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
  }

  /// Creates or updates the customer's portal login. `password` is required
  /// only when the login is brand new — the API enforces that, not the app.
  Future<void> setLogin(
    int customerId, {
    required String email,
    String? password,
    required int roleId,
    String? status,
  }) =>
      _api.post('/customers/$customerId/login', body: {
        'email': email.trim(),
        if (password != null && password.isNotEmpty) 'password': password,
        'role_id': roleId,
        if (status != null && status.isNotEmpty) 'status': status,
      });

  Future<void> setCatalog(int customerId, List<CatalogEntry> categories) =>
      _api.put('/customers/$customerId/catalog', body: {
        'categories': [for (final c in categories) c.toJson()],
      });

  // ── Website users ────────────────────────────────────────────
  Future<PagedResult<WebsiteUser>> websiteUsers({
    int page = 1,
    int perPage = 20,
    String? search,
  }) async {
    final query = <String, dynamic>{'page': page, 'per_page': perPage};
    if (search != null && search.trim().isNotEmpty) query['search'] = search.trim();
    final data = await _api.get('/website-users', query: query);
    return PagedResult<WebsiteUser>.fromData(data, WebsiteUser.fromJson);
  }

  Future<WebsiteUser> websiteUser(int id) async {
    final data = await _api.get('/website-users/$id');
    return WebsiteUser.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<WebsiteUser> createWebsiteUser(Map<String, dynamic> body) async {
    final data = await _api.post('/website-users', body: body);
    return WebsiteUser.fromJson((data as Map).cast<String, dynamic>());
  }

  Future<void> updateWebsiteUser(int id, Map<String, dynamic> body) =>
      _api.put('/website-users/$id', body: body);

  /// Issues a fresh api_token and returns it — this is the ONLY time the new
  /// token is visible, so the caller must show it immediately.
  Future<String?> regenerateToken(int id) async {
    final data = await _api.post('/website-users/$id/regenerate-token');
    if (data is Map) {
      final t = data['api_token'] ?? data['token'];
      return t?.toString();
    }
    return null;
  }
}

final portalRepositoryProvider = Provider<PortalRepository>((ref) {
  return PortalRepository(ref.watch(apiClientProvider));
});
