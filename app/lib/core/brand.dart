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
/// This is ONE of FOUR brand files — one per runtime, because they can't
/// share code: this one, web/config/brand.js, api/config/brand.js, and
/// agent/brand.py. They must all agree. api/tests/brandConsistency.test.js
/// pins name/tagline across all four and fails loudly if one is changed
/// without the others.
class Brand {
  Brand._();

  /// Full product name shown in the UI.
  static const String name = 'Teloora';

  /// Compact form for tight spaces.
  static const String shortName = 'Teloora';

  /// One-line description.
  static const String tagline = 'Connected Accounting';

  /// The single logo asset (splash / login). Replace the file to swap the logo.
  static const String logoAsset = 'assets/images/logo.svg';

  /// The full lock-up (mark + wordmark + tagline) — the same PNG the web
  /// sign-in / forgot pages show on their mobile breakpoint
  /// (web/public/img/logo-full.png). Keep the two files in step.
  static const String logoFullAsset = 'assets/images/logo-full.png';

  /// The launcher / app icon asset.
  static const String iconAsset = 'assets/icon/app_icon.png';

  /// Primary accent (matches web/config/brand.js color). One knob for the brand colour.
  static const String colorHex = '#1560E0';

  /// Full brand palette — the logo's blue→green gradient and its deep navy
  /// wordmark colour.
  static const String navyHex = '#17265E';
  static const String blueHex = '#1560E0';
  static const String greenHex = '#45B649';
}
