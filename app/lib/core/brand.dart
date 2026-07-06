/// core/brand.dart
///
/// SINGLE SOURCE OF TRUTH for the app's product brand (name + logo). Change it
/// HERE and it updates across the whole app: the MaterialApp title, the splash /
/// login / forgot screens, the update dialog, the sync-agent hint, and the
/// Settings default app name.
///
/// To rebrand:
///   • name / shortName / tagline  → edit the constants below.
///   • the logo image              → replace assets/images/logo.svg (same path).
///   • the launcher icon           → replace assets/icon/app_icon.png.
///
/// Mirrors the web brand at web/config/brand.js — keep the two in sync.
class Brand {
  Brand._();

  /// Full product name shown in the UI.
  static const String name = 'Tally Cloud Sync';

  /// Compact form for tight spaces.
  static const String shortName = 'Tally Cloud';

  /// One-line description.
  static const String tagline = 'Cloud accounting that syncs with Tally';

  /// The single logo asset (splash / login). Replace the file to swap the logo.
  static const String logoAsset = 'assets/images/logo.svg';

  /// The launcher / app icon asset.
  static const String iconAsset = 'assets/icon/app_icon.png';
}
