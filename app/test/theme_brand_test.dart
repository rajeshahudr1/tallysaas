import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/theme.dart';
import 'package:tallysaas_app/core/brand.dart';

/// WCAG relative luminance, used to check that text on a brand fill is
/// actually readable rather than merely on-brand.
double _luminance(Color c) {
  double channel(int v) {
    final s = v / 255.0;
    return s <= 0.03928 ? s / 12.92 : math.pow((s + 0.055) / 1.055, 2.4).toDouble();
  }

  return 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue);
}

double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = math.max(la, lb);
  final lo = math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  test('AppColors.fromHex parses a #RRGGBB string', () {
    expect(AppColors.fromHex('#1560E0'), const Color(0xFF1560E0));
    expect(AppColors.fromHex('17265E'), const Color(0xFF17265E));
  });

  test('the brand blue and navy come straight from Brand', () {
    expect(AppColors.primary, AppColors.fromHex(Brand.blueHex));
    expect(AppColors.sidebar, AppColors.fromHex(Brand.navyHex));
    expect(AppColors.secondary, AppColors.fromHex(Brand.navyHex));
  });

  test('the success colour is the brand green DARKENED to stay readable', () {
    // The logo green is 2.61:1 on white — unreadable as an icon or label, which
    // is what `success` is used for. It is deliberately not Brand.greenHex; the
    // logo asset itself is untouched.
    expect(AppColors.success, isNot(AppColors.fromHex(Brand.greenHex)));
    expect(_contrast(AppColors.success, Colors.white), greaterThanOrEqualTo(4.5));
  });

  test('the decorative sweep is the logo gradient', () {
    expect(AppGradients.brand.colors.first, AppColors.fromHex(Brand.blueHex));
    expect(AppGradients.brand.colors.last, AppColors.fromHex(Brand.greenHex));
  });

  test('the button sweep keeps white text readable at BOTH ends', () {
    // A filled button carries a white label across the whole width, so every
    // stop has to clear the contrast bar — the logo green does not.
    for (final stop in AppGradients.brandButton.colors) {
      expect(_contrast(stop, Colors.white), greaterThanOrEqualTo(4.5),
          reason: 'white text over $stop is unreadable');
    }
  });

  test('the nav surface is white', () {
    expect(AppColors.navSurface, const Color(0xFFFFFFFF));
  });

  test('light and dark themes still build', () {
    expect(AppTheme.light().useMaterial3, isTrue);
    expect(AppTheme.dark().useMaterial3, isTrue);
  });
}
