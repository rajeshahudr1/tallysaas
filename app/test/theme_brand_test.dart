import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/theme.dart';
import 'package:tallysaas_app/core/brand.dart';

void main() {
  test('AppColors.fromHex parses a #RRGGBB string', () {
    expect(AppColors.fromHex('#1560E0'), const Color(0xFF1560E0));
    expect(AppColors.fromHex('17265E'), const Color(0xFF17265E));
  });

  test('brand colours come from Brand, not hardcoded hexes', () {
    expect(AppColors.primary, AppColors.fromHex(Brand.blueHex));
    expect(AppColors.sidebar, AppColors.fromHex(Brand.navyHex));
    expect(AppColors.success, AppColors.fromHex(Brand.greenHex));
    expect(AppColors.secondary, AppColors.fromHex(Brand.navyHex));
  });

  test('the brand gradient runs blue → green and the nav surface is white', () {
    expect(AppGradients.brand.colors.first, AppColors.fromHex(Brand.blueHex));
    expect(AppGradients.brand.colors.last, AppColors.fromHex(Brand.greenHex));
    expect(AppColors.navSurface, const Color(0xFFFFFFFF));
  });

  test('light and dark themes still build', () {
    expect(AppTheme.light().useMaterial3, isTrue);
    expect(AppTheme.dark().useMaterial3, isTrue);
  });
}
