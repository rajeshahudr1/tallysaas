import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// Maps a status string (as it arrives from the API) to the app's status
/// palette. Used by the `StatusPill` widget, list-row chips, and dashboard
/// tiles so every surface agrees on what each colour means.
///
/// Buckets (case-insensitive; `*` denotes a prefix family):
///   • success (green) — Active, Created, Synced
///   • danger  (red)   — Inactive, Failed
///   • warn    (amber) — Blocked, Pending*
///   • info    (blue)  — Sent*
///   • muted   (grey)  — anything else / unknown / null
Color statusColor(String? s) {
  final v = (s ?? '').trim().toLowerCase();
  if (v.isEmpty) return AppColors.muted;

  switch (v) {
    case 'active':
    case 'created':
    case 'synced':
      return AppColors.success;
    case 'inactive':
    case 'failed':
      return AppColors.danger;
    case 'blocked':
      return AppColors.warn;
  }

  // Prefix families — `Pending`, `Pending Sync`, `Sent`, `Sent to Tally`…
  if (v.startsWith('pending')) return AppColors.warn;
  if (v.startsWith('sent'))    return AppColors.info;

  return AppColors.muted;
}
