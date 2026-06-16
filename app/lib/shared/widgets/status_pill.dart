import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/utils/status_colors.dart';

/// Rounded coloured pill for a status string (Active / Synced / Failed /
/// Pending / Sent …). The colour is resolved by [statusColor], so list
/// rows, sync logs, and invoice chips all agree on what each state means.
///
/// Pass the raw status text straight from the API; the pill renders it
/// verbatim, tinted to the matching status colour.
class StatusPill extends StatelessWidget {
  const StatusPill(this.text, {super.key});

  /// The status label to display (and colour by).
  final String text;

  @override
  Widget build(BuildContext context) {
    final color = statusColor(text);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: color.withOpacity(0.14),
        border: Border.all(color: color.withOpacity(0.38)),
        borderRadius: BorderRadius.circular(AppRadius.pill999),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w700,
          fontSize: 11,
          letterSpacing: 0.02,
        ),
      ),
    );
  }
}
