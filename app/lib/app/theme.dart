import 'package:flutter/material.dart';

/// Design tokens shared by the Material `ThemeData` AND any widget that needs
/// status colours / brand tints outside the theme system (status pills, charts,
/// the auth gradient). Mirrors the TallySaaS web brand (`#2563EB` / `#6D28D9`)
/// so the Web + Flutter UIs read like one product.
///
/// This file is the single source of truth: every other file imports
/// `AppColors` / `AppSpacing` / `AppRadius` / `AppTheme` from here.
class AppColors {
  AppColors._();

  // ─── Brand ──────────────────────────────────────────────────
  static const Color primary     = Color(0xFF2563EB); // brand blue
  static const Color primaryDeep = Color(0xFF1D4ED8); // pressed / deep blue
  static const Color secondary   = Color(0xFF6D28D9); // brand violet
  static const Color sidebar     = Color(0xFF111827); // dark nav surface

  // ─── Surfaces (light) ───────────────────────────────────────
  static const Color scaffoldBg  = Color(0xFFF8FAFC);
  static const Color card        = Color(0xFFFFFFFF);
  static const Color border      = Color(0xFFE5E7EB);

  // ─── Text ───────────────────────────────────────────────────
  static const Color text1       = Color(0xFF111827); // primary copy
  static const Color text2       = Color(0xFF6B7280); // secondary copy
  static const Color text3       = Color(0xFF9CA3AF); // hints / disabled

  // ─── Status (drives status_colors.dart + StatusPill) ────────
  static const Color success     = Color(0xFF16A34A); // active / success
  static const Color danger      = Color(0xFFDC2626); // danger / inactive
  static const Color warn        = Color(0xFFD97706); // blocked / pending
  static const Color info        = Color(0xFF2563EB); // sent / info
  static const Color muted       = Color(0xFF6B7280); // neutral / unknown
}

/// Spacing scale — keep paddings + gaps consistent with the web's `--space-N`
/// variables. Use these constants instead of literal numbers so a future
/// redesign is a single-file change.
class AppSpacing {
  AppSpacing._();
  static const double xs4  = 4;
  static const double sm8  = 8;
  static const double md12 = 12;
  static const double lg16 = 16;
  static const double xl24 = 24;
  static const double xxl32 = 32;
}

/// Corner radii used across cards, inputs, buttons and pills.
class AppRadius {
  AppRadius._();
  static const double sm8   = 8;
  static const double md12  = 12;
  static const double lg16  = 16;
  static const double pill999 = 999;
}

/// Material 3 themes. The whole palette is derived from
/// `ColorScheme.fromSeed(seedColor: AppColors.primary)` so component defaults
/// (ripples, focus rings, selection) stay on-brand, then we override the
/// surfaces / cards / inputs / buttons to match the web exactly.
///
/// `themeMode` is pinned to `ThemeMode.light` by the app for Phase 1, but
/// `dark()` is provided so a later phase can flip it without touching screens.
class AppTheme {
  AppTheme._();

  static ThemeData light() => _build(
        brightness: Brightness.light,
        scheme: ColorScheme.fromSeed(
          seedColor: AppColors.primary,
          brightness: Brightness.light,
          surface: AppColors.card,
          onSurface: AppColors.text1,
        ),
        scaffoldBg: AppColors.scaffoldBg,
        cardBg:     AppColors.card,
        elevBg:     AppColors.scaffoldBg,
        border:     AppColors.border,
        text1:      AppColors.text1,
        text2:      AppColors.text2,
      );

  static ThemeData dark() => _build(
        brightness: Brightness.dark,
        scheme: ColorScheme.fromSeed(
          seedColor: AppColors.primary,
          brightness: Brightness.dark,
          surface: const Color(0xFF111827),
          onSurface: const Color(0xFFE5E7EB),
        ),
        scaffoldBg: const Color(0xFF0B1220),
        cardBg:     const Color(0xFF111827),
        elevBg:     const Color(0xFF1F2937),
        border:     const Color(0xFF1F2937),
        text1:      const Color(0xFFE5E7EB),
        text2:      const Color(0xFF9CA3AF),
      );

  static ThemeData _build({
    required Brightness brightness,
    required ColorScheme scheme,
    required Color scaffoldBg,
    required Color cardBg,
    required Color elevBg,
    required Color border,
    required Color text1,
    required Color text2,
  }) {
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: scaffoldBg,
    );

    return base.copyWith(
      // ─── Typography ─────────────────────────────────────────
      // Info-dense product (lists, tables, tiles), so the giant default
      // headlines are dialed down in favour of compact, legible weights.
      textTheme: base.textTheme
          .apply(bodyColor: text1, displayColor: text1)
          .copyWith(
            headlineSmall: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: text1),
            titleLarge:    TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: text1),
            titleMedium:   TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: text1),
            titleSmall:    TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: text2, letterSpacing: 0.04),
            bodyLarge:     TextStyle(fontSize: 14, color: text1),
            bodyMedium:    TextStyle(fontSize: 13, color: text1),
            bodySmall:     TextStyle(fontSize: 12, color: text2),
            labelLarge:    const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),

      // ─── App bar — flat, scaffold-coloured ──────────────────
      appBarTheme: AppBarTheme(
        backgroundColor: scaffoldBg,
        foregroundColor: text1,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 17, fontWeight: FontWeight.w700, color: text1,
        ),
      ),

      // ─── Cards — soft 1px border, no harsh shadow ───────────
      cardTheme: CardTheme(
        color: cardBg,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: border, width: 1),
          borderRadius: BorderRadius.circular(AppRadius.md12),
        ),
      ),

      // ─── Inputs — filled, light fill, brand focus ring ──────
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: elevBg,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md12, vertical: AppSpacing.md12,
        ),
        hintStyle: TextStyle(color: text2),
        labelStyle: TextStyle(color: text2),
        floatingLabelStyle: const TextStyle(color: AppColors.primary),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          borderSide: BorderSide(color: border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          borderSide: BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          borderSide: const BorderSide(color: AppColors.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
          borderSide: const BorderSide(color: AppColors.danger, width: 1.5),
        ),
      ),

      // ─── Buttons — primary blue with white foreground ───────
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm8),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: text1,
          side: BorderSide(color: border),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm8),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: AppColors.primary),
      ),

      // ─── Misc ───────────────────────────────────────────────
      dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: cardBg,
        contentTextStyle: TextStyle(color: text1),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm8),
        ),
      ),

      // ─── Bottom navigation — brand-blue selected ────────────
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: cardBg,
        indicatorColor: AppColors.primary.withOpacity(0.12),
        elevation: 0,
        labelTextStyle: MaterialStateProperty.resolveWith((states) {
          final selected = states.contains(MaterialState.selected);
          return TextStyle(
            fontSize: 12,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
            color: selected ? AppColors.primary : text2,
          );
        }),
        iconTheme: MaterialStateProperty.resolveWith((states) {
          final selected = states.contains(MaterialState.selected);
          return IconThemeData(
            color: selected ? AppColors.primary : text2,
          );
        }),
      ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: cardBg,
        selectedItemColor: AppColors.primary,
        unselectedItemColor: text2,
        type: BottomNavigationBarType.fixed,
        showUnselectedLabels: true,
      ),
    );
  }
}
