import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/user.dart';
import '../../data/repositories/auth_repository.dart';
import '../api/api_exception.dart';
import 'session.dart';
import 'token_storage.dart';

/// Glue between the auth Repository (HTTP), TokenStorage (SecureStorage)
/// and SessionController (in-memory state). Screens call methods on this
/// service; everything else (router redirects, profile screen) just
/// watches `sessionProvider`.
///
///   • `hydrate()`        — read cached token + user blob, set sessionState.
///   • `login()`          — POST /auth/login, persist creds, signal signed-in.
///   • `logout()`         — POST /auth/logout, clear creds, signal anonymous.
///   • `switchCompany()`  — rewrite the active company id, refresh /me.
///
/// Built ref-based so it can resolve the repository / storage / session
/// notifier lazily and stay a synchronous `Provider`.
class AuthService {
  AuthService(this._ref);

  final Ref _ref;

  AuthRepository    get _repo    => _ref.read(authRepositoryProvider);
  TokenStorage      get _tokens  => _ref.read(tokenStorageProvider);
  SessionController  get _session => _ref.read(sessionProvider.notifier);

  /// Called once at app boot from `SplashScreen.initState`. Reads the
  /// stored token + cached user blob; on success flips `sessionState` to
  /// signed-in, otherwise anonymous. The dashboard then refreshes from the
  /// network on its own — we don't round-trip /me here so the splash clears
  /// quickly.
  Future<void> hydrate() async {
    final token = await _tokens.readToken();
    final blob  = await _tokens.readUserBlob();
    if (token == null || token.isEmpty || blob == null || blob.isEmpty) {
      _session.setAnonymous();
      return;
    }
    try {
      final json = jsonDecode(blob) as Map<String, dynamic>;
      _session.setSignedIn(AppUser.fromJson(json));
    } catch (_) {
      // Corrupt blob — wipe + treat as logged-out so the user can recover
      // by signing in again.
      await _tokens.clear();
      _session.setAnonymous();
    }
  }

  /// POST `/auth/login`. Persists the token, the user's home company id
  /// (so the very first scoped request carries `X-Company-Id`), and the
  /// cached user blob, then flips the session to signed-in.
  Future<void> login(String email, String password) async {
    final (token, user) = await _repo.login(email, password);
    if (token.isEmpty) {
      throw ApiException(
        'Login succeeded but no token was returned.',
        httpStatus: 500,
      );
    }
    await _tokens.writeToken(token);
    if (user.companyId != null) {
      await _tokens.writeCompanyId(user.companyId.toString());
    }
    await _tokens.writeUserBlob(jsonEncode(user.toJson()));
    _session.setSignedIn(user);
  }

  /// Tell the server to invalidate the session, then clear local creds.
  /// We swallow any network error from the logout call — the user wants to
  /// be signed out locally regardless of whether the server acknowledged.
  Future<void> logout() async {
    try {
      await _repo.logout();
    } catch (_) {
      // Best-effort; proceed to clear local state either way.
    }
    await _tokens.clear();
    _session.setAnonymous();
  }

  /// Switch the active company. The switch is purely client-side: we
  /// rewrite the stored company id (which the interceptor sends as
  /// `X-Company-Id`) then re-fetch `/me` so the cached user + permissions
  /// reflect the new scope.
  Future<void> switchCompany(String id) async {
    await _tokens.writeCompanyId(id);
    final user = await _repo.me();
    await _tokens.writeUserBlob(jsonEncode(user.toJson()));
    _session.setSignedIn(user);
  }
}

final authServiceProvider = Provider<AuthService>((ref) {
  return AuthService(ref);
});
