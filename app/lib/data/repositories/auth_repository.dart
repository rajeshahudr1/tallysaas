import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/endpoints.dart';
import '../models/user.dart';

/// Thin wrapper around the TallySaaS auth endpoints. Lives in the data layer
/// so the UI never sees Dio or the wire envelope — callers get a typed
/// `(String token, AppUser user)` / `AppUser`, or an `ApiException`.
///
/// The [ApiClient] has already unwrapped the Node envelope
/// `{status, show, msg, data}` by the time we read a response, so these
/// methods only deal with the `data` payload.
class AuthRepository {
  AuthRepository(this._api);
  final ApiClient _api;

  /// `POST /auth/login` with `{email, password}`.
  ///
  /// On success the unwrapped `data` is `{token, user{…}, expires_in}`. We
  /// pull the JWT out as a raw string and parse the embedded user object into
  /// an [AppUser]; the caller (AuthService) is responsible for persisting the
  /// token + company id + user blob and flipping the session.
  Future<(String token, AppUser user)> login(
    String email,
    String password,
  ) async {
    final data = await _api.post(Endpoints.login, body: {
      'email': email.trim(),
      'password': password,
    });
    if (data is! Map) {
      throw StateError('Login response was not a JSON object.');
    }
    final map = data.cast<String, dynamic>();

    final token = (map['token'] ?? '').toString();
    final rawUser = map['user'];
    if (token.isEmpty || rawUser is! Map) {
      throw StateError('Login response missing token or user.');
    }

    final user = AppUser.fromJson(rawUser.cast<String, dynamic>());
    return (token, user);
  }

  /// `GET /me` — returns the current user resolved for the active company
  /// (the `X-Company-Id` header on the request selects the tenant). Used to
  /// refresh the session after a company switch.
  Future<AppUser> me() async {
    final data = await _api.get(Endpoints.me);
    if (data is! Map) {
      throw StateError('Profile response was not a JSON object.');
    }
    return AppUser.fromJson(data.cast<String, dynamic>());
  }

  /// `POST /auth/logout` — best-effort server-side session invalidation.
  /// AuthService clears local storage regardless of the outcome.
  Future<void> logout() async {
    await _api.post(Endpoints.logout);
  }
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(ref.watch(apiClientProvider));
});
