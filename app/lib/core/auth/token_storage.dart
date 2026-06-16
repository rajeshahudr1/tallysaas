import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../constants.dart';

/// Wraps `flutter_secure_storage` for the three credentials we persist:
///
///   • `authToken` — JWT issued by `/auth/login`, attached as
///                   `Authorization: Bearer …` on every request.
///   • `companyId` — the active tenant id, attached as `X-Company-Id` so a
///                   re-open hits the same company scope. The company
///                   switcher just rewrites this value.
///   • `userBlob`  — JSON of the user profile so the splash screen can skip
///                   the network and hydrate the session instantly on open.
///
/// All reads are async (Android KeyStore / iOS Keychain hops). Callers
/// should `await` in init paths and treat absence as logged-out.
class TokenStorage {
  TokenStorage(this._storage);

  // `aOptions` keeps the Android side on EncryptedSharedPreferences; iOS
  // defaults to the Keychain. Both encrypt at rest.
  final FlutterSecureStorage _storage;

  factory TokenStorage.create() =>
      TokenStorage(const FlutterSecureStorage(
        aOptions: AndroidOptions(encryptedSharedPreferences: true),
      ));

  Future<String?> readToken() => _storage.read(key: AppConfig.kAuthToken);
  Future<void>    writeToken(String token) =>
      _storage.write(key: AppConfig.kAuthToken, value: token);

  Future<String?> readCompanyId() => _storage.read(key: AppConfig.kCompanyId);
  Future<void>    writeCompanyId(String id) =>
      _storage.write(key: AppConfig.kCompanyId, value: id);

  Future<String?> readUserBlob() => _storage.read(key: AppConfig.kUserCache);
  Future<void>    writeUserBlob(String json) =>
      _storage.write(key: AppConfig.kUserCache, value: json);

  /// Clear every credential — wired to logout + any unauthenticated
  /// response from the API.
  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: AppConfig.kAuthToken),
      _storage.delete(key: AppConfig.kCompanyId),
      _storage.delete(key: AppConfig.kUserCache),
    ]);
  }
}

final tokenStorageProvider = Provider<TokenStorage>((ref) {
  return TokenStorage.create();
});
