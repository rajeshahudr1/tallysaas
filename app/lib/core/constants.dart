/// App-wide constants. Centralised so a build-time swap (dev / staging /
/// prod) only touches one file. Most values are compile-time defaults but
/// can be overridden at `--dart-define=KEY=value` for CI builds.
library;

class AppConfig {
  AppConfig._();

  /// The Node API base URL. Default matches the local-dev server reachable
  /// from the Android emulator; CI builds override via
  /// `flutter build apk --dart-define=API_BASE=https://...`.
  static const String apiBase = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'http://10.0.2.2:4500', // Android emulator → host machine
  );

  /// REST path prefix the Node API exposes (`/api/v1/...`). Combined with
  /// [apiBase] to form the Dio base URL.
  static const String apiPrefix = '/api/v1';

  /// The WEB app's public base URL — used only to build the customer-facing
  /// payment link (`<webBase>/pay/<token>`), which is served by the web app,
  /// not the API. Blank means "unknown": the Collect Payments screen then
  /// shares the raw token instead of guessing a wrong URL. Override per build
  /// with `--dart-define=WEB_BASE=https://app.example.com`.
  static const String webBase = String.fromEnvironment('WEB_BASE', defaultValue: '');

  /// The public payment link for [token], or null when [webBase] is unset.
  static String? payLink(String? token) {
    if (token == null || token.isEmpty || webBase.isEmpty) return null;
    final base = webBase.endsWith('/')
        ? webBase.substring(0, webBase.length - 1)
        : webBase;
    return '$base/pay/$token';
  }

  /// Asset paths — referenced by widgets that need the brand logo.
  static const String logoAsset = 'assets/images/logo.png';

  /// Storage keys used by SecureStorage + SharedPreferences. Centralised so
  /// a typo here is a compile-error instead of a silent bug.
  ///
  ///   • [kAuthToken] — JWT issued by `/auth/login`, attached as
  ///                    `Authorization: Bearer …` on every request.
  ///   • [kCompanyId] — the active company id, attached as `X-Company-Id`
  ///                    so the server scopes every query to the right tenant.
  ///                    (TallySaaS scopes by company *id*, not slug.)
  ///   • [kUserCache] — JSON of the user profile so the splash screen can
  ///                    hydrate the session instantly on app open.
  ///   • [kThemeKey]  — persisted theme-mode preference.
  static const String kAuthToken = 'tcs.auth.token';
  static const String kCompanyId = 'tcs.auth.companyId';
  static const String kUserCache = 'tcs.auth.user';
  static const String kThemeKey  = 'tcs.theme';
}
